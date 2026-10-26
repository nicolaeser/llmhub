import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";

const ACCOUNTS = [
  { id: "acct-a", weight: 10 },
  { id: "acct-b", weight: 5 },
];

function groupRow(alias: string, kind: string, options: { numRetries?: number; strategy?: string } = {}) {
  return {
    alias,
    enabled: true,
    strategy: options.strategy ?? "priority",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    priceWindows: [],
    overflowGroup: "",
    numRetries: options.numRetries ?? 0,
    fallbackGroups: [],
    deployments: ACCOUNTS.map((account) => ({
      id: `${alias}-${account.id}`,
      kind,
      baseUrl: "",
      model: `${alias}-model`,
      weight: account.weight,
      costInput: 0,
      costOutput: 0,
      providerId: account.id,
      provider: {
        id: account.id,
        kind,
        baseUrl: "",
        apiKey: "",
        zdr: false,
        retentionDays: null,
        region: "",
        noTraining: false,
        enabled: true,
        restricted: false,
        assignments: [],
        login: kind === "anthropic" ? null : { status: "active" },
      },
    })),
  };
}

const groups = new Map<string, ReturnType<typeof groupRow>>();

(globalThis as { prisma?: unknown }).prisma = {
  modelGroup: { findUnique: async ({ where }: { where: { alias: string } }) => groups.get(where.alias) ?? null },
  providerConnection: { findMany: async () => [], findUnique: async () => null },
  deployment: { findMany: async () => [] },
  providerLogin: { findUnique: async () => null },
  accountRouting: { findMany: async () => [{ kind: "claude", strategy: "inherit" }] },
  setting: { findUnique: async () => null },
  gatewayAuditLog: { create: async () => ({}) },
};

delete process.env.REDIS_URL;

let counter = 0;

function freshGroup(kind = "claude", options: { numRetries?: number; strategy?: string } = {}): string {
  counter += 1;
  const alias = `resilience-${counter}`;
  groups.set(alias, groupRow(alias, kind, options));
  return alias;
}

async function route<T>(
  alias: string,
  fn: (dep: ResolvedDeployment) => Promise<T>,
  opts: { request?: JsonMap; signal?: AbortSignal; headers?: Record<string, string>; pool?: "api" | "subscription" } = {},
) {
  const { withDeployment } = await import("@/lib/gateway/dispatch/chat");
  return withDeployment([alias], {}, (dep) => fn(dep), { pool: "subscription", ...opts });
}

async function settled(): Promise<void> {
  for (let wait = 0; wait < 20; wait++) await new Promise((resolve) => setImmediate(resolve));
}

async function cooling(alias: string, account: string): Promise<number | null> {
  const { cooldownEnds } = await import("@/lib/gateway/routing/provider-health");
  return (await cooldownEnds([`${alias}-${account}`])).get(`${alias}-${account}`) ?? null;
}

async function upstream(status: number, body: JsonMap, headers: Record<string, string> = {}) {
  const { upstreamError } = await import("@/lib/gateway/dispatch/upstream");
  return upstreamError(status, body, new Headers(headers));
}

function session(id: string): JsonMap {
  return {
    model: "m",
    metadata: { user_id: JSON.stringify({ device_id: "d", session_id: id }) },
    messages: [{ role: "user", content: "hi" }],
  };
}

beforeEach(async () => {
  const { forgetPins } = await import("@/lib/gateway/routing/account-affinity");
  forgetPins();
});

test("a client that hangs up before the upstream answers stops routing without blaming the account", async () => {
  const { isClientClosed } = await import("@/lib/gateway/errors");
  const alias = freshGroup("claude", { numRetries: 2 });
  for (let round = 0; round < 3; round++) {
    const client = new AbortController();
    const served: string[] = [];
    const failure = await route(
      alias,
      async (dep) => {
        served.push(dep.provider_id);
        client.abort();
        throw new DOMException("This operation was aborted", "AbortError");
      },
      { signal: client.signal },
    ).catch((err: unknown) => err);
    assert.ok(isClientClosed(failure));
    assert.equal((failure as { status: number }).status, 499);
    assert.deepEqual(served, ["acct-a"]);
  }
  assert.equal(await cooling(alias, "acct-a"), null);
  const routed = await route(alias, async (dep) => dep.provider_id);
  assert.equal(routed.result, "acct-a");
});

test("a request whose client already left is not sent upstream", async () => {
  const alias = freshGroup();
  const client = new AbortController();
  client.abort();
  const served: string[] = [];
  await assert.rejects(route(alias, async (dep) => served.push(dep.provider_id), { signal: client.signal }), {
    status: 499,
  });
  assert.deepEqual(served, []);
});

test("an exhausted five-hour window parks the account until its reset and moves the pin", async () => {
  const { readPin, runSession } = await import("@/lib/gateway/routing/account-affinity");
  const alias = freshGroup();
  const request = session("window-run");
  const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
  const served: string[] = [];
  const routed = await route(
    alias,
    async (dep) => {
      served.push(dep.provider_id);
      if (dep.provider_id === "acct-a") {
        throw await upstream(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
          {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-5h-reset": String(reset),
            "anthropic-ratelimit-unified-reset": String(reset),
            "retry-after": "30",
          },
        );
      }
      return "ok";
    },
    { request },
  );
  assert.deepEqual(served, ["acct-a", "acct-b"]);
  assert.equal(routed.dep.provider_id, "acct-b");
  assert.equal(await cooling(alias, "acct-a"), reset * 1000);
  await settled();
  assert.equal((await readPin("claude", runSession(request)))?.providerId, "acct-b");
});

test("a short throttle honors Retry-After and keeps the session on its account", async () => {
  const { readPin, runSession, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const alias = freshGroup();
  const request = session("throttle-run");
  await writePin("claude", runSession(request), { providerId: "acct-a", handoffAt: 0 }, null);
  const served: string[] = [];
  const started = Date.now();
  const routed = await route(
    alias,
    async (dep) => {
      served.push(dep.provider_id);
      if (dep.provider_id === "acct-a") {
        throw await upstream(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "Please slow down" } },
          { "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-reset": "1900000000", "retry-after": "20" },
        );
      }
      return "ok";
    },
    { request },
  );
  assert.equal(routed.dep.provider_id, "acct-b");
  const until = await cooling(alias, "acct-a");
  assert.ok(until !== null && until >= started + 20_000 && until <= Date.now() + 25_000, String(until));
  await settled();
  assert.equal((await readPin("claude", runSession(request)))?.providerId, "acct-a");
  const next = await route(alias, async (dep) => dep.provider_id, { request });
  assert.equal(next.result, "acct-b");
  await settled();
  assert.equal((await readPin("claude", runSession(request)))?.providerId, "acct-a");
});

test("an overloaded upstream neither cools the account nor moves the pin", async () => {
  const { readPin, runSession, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const { toGateError } = await import("@/lib/gateway/access/gate");
  const alias = freshGroup("claude", { numRetries: 1 });
  const request = session("overloaded-run");
  await writePin("claude", runSession(request), { providerId: "acct-a", handoffAt: 0 }, null);
  for (let round = 0; round < 2; round++) {
    const served: string[] = [];
    const failure = await route(
      alias,
      async (dep) => {
        served.push(dep.provider_id);
        throw await upstream(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { "retry-after": "3" });
      },
      { request },
    ).catch((err: unknown) => err);
    assert.deepEqual(served, ["acct-a", "acct-a"]);
    const gate = toGateError(failure);
    assert.equal(gate.status, 529);
    assert.ok(gate.retryAt !== null && gate.retryAt > Date.now());
  }
  assert.equal(await cooling(alias, "acct-a"), null);
  const routed = await route(alias, async (dep) => dep.provider_id, { request });
  assert.equal(routed.result, "acct-a");
  await settled();
  assert.equal((await readPin("claude", runSession(request)))?.providerId, "acct-a");
});

test("transient server errors serve the turn elsewhere but keep the pin", async () => {
  const { readPin, runSession, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const alias = freshGroup("claude", { numRetries: 2 });
  const request = session("transient-run");
  await writePin("claude", runSession(request), { providerId: "acct-a", handoffAt: 0 }, null);
  const served: string[] = [];
  const routed = await route(
    alias,
    async (dep) => {
      served.push(dep.provider_id);
      if (dep.provider_id === "acct-a") throw await upstream(502, { error: { message: "bad gateway" } });
      return "ok";
    },
    { request },
  );
  assert.deepEqual(served, ["acct-a", "acct-a", "acct-b"]);
  assert.equal(routed.dep.provider_id, "acct-b");
  await settled();
  assert.equal((await readPin("claude", runSession(request)))?.providerId, "acct-a");
});

test("a subscription account that answers 403 is cooled and the request moves to the next account", async () => {
  const { readPin, runSession, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const alias = freshGroup();
  const request = session("forbidden-run");
  await writePin("claude", runSession(request), { providerId: "acct-a", handoffAt: 0 }, null);
  const served: string[] = [];
  const routed = await route(
    alias,
    async (dep) => {
      served.push(dep.provider_id);
      if (dep.provider_id === "acct-a") {
        throw await upstream(403, { type: "error", error: { type: "permission_error", message: "This organization has been disabled." } });
      }
      return "ok";
    },
    { request },
  );
  assert.deepEqual(served, ["acct-a", "acct-b"]);
  assert.equal(routed.dep.provider_id, "acct-b");
  const until = await cooling(alias, "acct-a");
  assert.ok(until !== null && until - Date.now() > 25 * 60_000);
  await settled();
  assert.equal((await readPin("claude", runSession(request)))?.providerId, "acct-b");
  const next: string[] = [];
  await route(alias, async (dep) => next.push(dep.provider_id));
  assert.deepEqual(next, ["acct-b"]);
});

test("accounts that are all rejected report the upstream error and later a retryable outage, not a usage limit", async () => {
  const { toGateError } = await import("@/lib/gateway/access/gate");
  const alias = freshGroup();
  const failure = await route(alias, async () => {
    throw await upstream(402, { type: "error", error: { type: "billing_error", message: "Subscription inactive." } });
  }).catch((err: unknown) => err);
  assert.equal(toGateError(failure).status, 402);
  const later = toGateError(await route(alias, async () => "unreachable").catch((err: unknown) => err));
  assert.equal(later.status, 503);
  assert.equal(later.code, "no_healthy_deployment");
});

test("a model the account cannot serve is cooled for that model only", async () => {
  const primary = freshGroup();
  const other = freshGroup();
  const served: string[] = [];
  const routed = await route(primary, async (dep) => {
    served.push(dep.provider_id);
    if (dep.provider_id === "acct-a") {
      throw await upstream(404, { type: "error", error: { type: "not_found_error", message: `model: ${dep.model}` } });
    }
    return "ok";
  });
  assert.deepEqual(served, ["acct-a", "acct-b"]);
  assert.equal(routed.dep.provider_id, "acct-b");
  assert.ok(((await cooling(primary, "acct-a")) ?? 0) - Date.now() > 50 * 60_000);
  const elsewhere = await route(other, async (dep) => dep.provider_id);
  assert.equal(elsewhere.result, "acct-a");
});

test("a 404 that is not about the model stays a caller error", async () => {
  const alias = freshGroup();
  const served: string[] = [];
  await assert.rejects(
    route(alias, async (dep) => {
      served.push(dep.provider_id);
      throw await upstream(404, { type: "error", error: { type: "not_found_error", message: "Not Found" } });
    }),
    { status: 404 },
  );
  assert.deepEqual(served, ["acct-a"]);
  assert.equal(await cooling(alias, "acct-a"), null);
});

test("a fast mode refusal is answered without cooling or rotating accounts", async () => {
  const { gateResponse } = await import("@/lib/gateway/access/gate");
  const alias = freshGroup("claude", { numRetries: 2 });
  const served: string[] = [];
  const failure = await route(alias, async (dep) => {
    served.push(dep.provider_id);
    throw await upstream(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Usage credits are required for fast mode." } },
      { "retry-after": "60", "anthropic-ratelimit-unified-status": "allowed" },
    );
  }).catch((err: unknown) => err);
  assert.deepEqual(served, ["acct-a"]);
  assert.equal(await cooling(alias, "acct-a"), null);
  assert.equal(await cooling(alias, "acct-b"), null);
  const response = gateResponse(failure, new Request("http://hub.local/api/subscription/v1/messages", { method: "POST" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(response.headers.get("x-should-retry"), "false");
});

test("Anthropic API keys keep a session on one key while other traffic still spreads", async () => {
  const { readPin, runSession } = await import("@/lib/gateway/routing/account-affinity");
  const alias = freshGroup("anthropic", { strategy: "round_robin" });
  const request = session("api-key-run");
  const pinned: string[] = [];
  for (let i = 0; i < 4; i++) {
    const routed = await route(alias, async (dep) => dep.provider_id, { request, pool: "api" });
    pinned.push(routed.result);
    await settled();
  }
  assert.equal(new Set(pinned).size, 1);
  assert.equal((await readPin("anthropic", runSession(request)))?.providerId, pinned[0]);
  const spread = new Set<string>();
  for (let i = 0; i < 4; i++) spread.add((await route(alias, async (dep) => dep.provider_id, { pool: "api" })).result);
  assert.equal(spread.size, 2);
});

test("an Anthropic API key that hits a short throttle keeps the session pin", async () => {
  const { readPin, runSession, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const alias = freshGroup("anthropic", { numRetries: 1 });
  const request = session("api-key-throttle");
  await writePin("anthropic", runSession(request), { providerId: "acct-a", handoffAt: 0 }, null);
  const routed = await route(
    alias,
    async (dep) => {
      if (dep.provider_id === "acct-a") {
        throw await upstream(429, { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }, { "retry-after": "5" });
      }
      return "ok";
    },
    { request, pool: "api" },
  );
  assert.equal(routed.dep.provider_id, "acct-b");
  await settled();
  assert.equal((await readPin("anthropic", runSession(request)))?.providerId, "acct-a");
});

test("the Claude Code session header keys the run like metadata.user_id", async () => {
  const { readPin, runSession, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const fromHeader = runSession({ messages: [] }, { "X-Claude-Code-Session-Id": "header-run" });
  assert.notEqual(fromHeader, "");
  assert.equal(fromHeader, runSession(session("header-run")));
  assert.equal(runSession({ prompt_cache_key: "key-run" }, { "x-claude-code-session-id": "header-run" }), runSession({ prompt_cache_key: "key-run" }));
  assert.equal(runSession(session("meta-run"), { "x-claude-code-session-id": "header-run" }), runSession(session("meta-run")));
  assert.equal(runSession({}, {}), "");
  const alias = freshGroup();
  await writePin("claude", fromHeader, { providerId: "acct-b", handoffAt: 0 }, null);
  const routed = await route(alias, async (dep) => dep.provider_id, {
    request: { messages: [] },
    headers: { "x-claude-code-session-id": "header-run" },
  });
  assert.equal(routed.result, "acct-b");
  assert.equal((await readPin("claude", fromHeader))?.providerId, "acct-b");
});
