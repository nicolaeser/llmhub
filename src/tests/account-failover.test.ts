import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { JsonMap } from "@/types/gateway";
import type { SubscriptionLimits } from "@/types/providers";
import type { ResolvedDeployment } from "@/types/routing";

type FakeAccount = { id: string; deployment: string; weight: number };

const ACCOUNTS: FakeAccount[] = [
  { id: "acct-a", deployment: "dep-a", weight: 10 },
  { id: "acct-b", deployment: "dep-b", weight: 5 },
];

function groupRow(alias: string, numRetries = 0, overflowGroup = "") {
  return {
    alias,
    enabled: true,
    strategy: "priority",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    priceWindows: [],
    overflowGroup,
    numRetries,
    fallbackGroups: [],
    deployments: ACCOUNTS.map((account) => ({
      id: `${alias}-${account.deployment}`,
      kind: "codex",
      baseUrl: "",
      model: "gpt-test",
      weight: account.weight,
      costInput: 0,
      costOutput: 0,
      providerId: account.id,
      provider: {
        id: account.id,
        kind: "codex",
        baseUrl: "",
        apiKey: "",
        zdr: false,
        retentionDays: null,
        region: "",
        noTraining: false,
        enabled: true,
        restricted: false,
        assignments: [],
        login: { status: "active" },
      },
    })),
  };
}

const groups = new Map<string, ReturnType<typeof groupRow>>();
const resetChecks: string[] = [];

(globalThis as { prisma?: unknown }).prisma = {
  modelGroup: { findUnique: async ({ where }: { where: { alias: string } }) => groups.get(where.alias) ?? null },
  providerConnection: {
    findMany: async () => [],
    findUnique: async ({ where }: { where: { id: string } }) => {
      resetChecks.push(where.id);
      return null;
    },
  },
  deployment: { findMany: async () => [] },
  providerLogin: { findUnique: async () => null },
  accountRouting: { findMany: async () => [] },
  setting: { findUnique: async () => null },
  gatewayAuditLog: { create: async () => ({}) },
};

delete process.env.REDIS_URL;

let alias = "";
let counter = 0;

function freshGroup(numRetries = 0): string {
  counter += 1;
  alias = `failover-${counter}`;
  groups.set(alias, groupRow(alias, numRetries));
  return alias;
}

async function route<T>(fn: (dep: ResolvedDeployment) => Promise<T>, request?: JsonMap) {
  const { withDeployment } = await import("@/lib/gateway/dispatch/chat");
  return withDeployment([alias], {}, (dep) => fn(dep), { pool: "subscription", request });
}

async function limitError(message = "You've hit your usage limit.", retryAt = Date.now() + 3_600_000) {
  const { GateError } = await import("@/lib/gateway/errors");
  return new GateError(429, "upstream_error", message, { upstreamCode: "usage_limit_reached", retryAt });
}

function reasoningOf(request: JsonMap): string[] {
  const messages = (request.messages as JsonMap[]) ?? [];
  return messages.flatMap((message) =>
    Array.isArray(message.thinking_blocks) ? (message.thinking_blocks as JsonMap[]).map((block) => String(block.signature)) : [],
  );
}

beforeEach(async () => {
  const { forgetPins } = await import("@/lib/gateway/routing/account-affinity");
  forgetPins();
  freshGroup();
});

test("a usage limit asks the banked reset policy of the exhausted account", async () => {
  resetChecks.length = 0;
  await route(async (dep) => {
    if (dep.provider_id === "acct-a") throw await limitError();
    return "answer";
  });
  for (let wait = 0; wait < 50 && !resetChecks.length; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(resetChecks, ["acct-a"]);
});

test("a usage limit on one account moves the same request to the next account even without retries", async () => {
  const served: string[] = [];
  const routed = await route(async (dep) => {
    served.push(dep.provider_id);
    if (dep.provider_id === "acct-a") throw await limitError();
    return "answer";
  });
  assert.deepEqual(served, ["acct-a", "acct-b"]);
  assert.equal(routed.result, "answer");
  assert.equal(routed.dep.provider_id, "acct-b");
});

test("when every account is exhausted the caller gets a usage limit error with the earliest reset", async () => {
  const { toGateError } = await import("@/lib/gateway/access/gate");
  const resets = new Map([
    ["acct-a", Date.now() + 3 * 3_600_000],
    ["acct-b", Date.now() + 2 * 3_600_000],
  ]);
  const served: string[] = [];
  const failure = await route(async (dep) => {
    served.push(dep.provider_id);
    throw await limitError("Usage limit reached until 18:00.", resets.get(dep.provider_id));
  }).catch((err: unknown) => err);
  assert.deepEqual(served, ["acct-a", "acct-b"]);
  const gate = toGateError(failure);
  assert.equal(gate.status, 429);
  assert.equal(gate.code, "rate_limit_exceeded");
  assert.equal(gate.retryAt, resets.get("acct-b"));
  assert.match(gate.message, /^all ChatGPT subscription \(Codex\) accounts have reached their usage limit; /);
  assert.match(gate.message, /\(in 2h\)$/);
});

function sessionAndWeek(sessionResetAt: number, weekResetAt: number, weekPercent: number): SubscriptionLimits {
  const at = (time: number) => new Date(time).toISOString();
  return {
    plan: "pro",
    windows: [
      { scope: "", usedPercent: 100, windowSeconds: 18_000, resetsAt: at(sessionResetAt), limitReached: true },
      { scope: "", usedPercent: weekPercent, windowSeconds: 604_800, resetsAt: at(weekResetAt), limitReached: weekPercent >= 100 },
    ],
    credits: null,
    resetCredits: null,
    extraUsage: null,
    fetchedAt: at(Date.now()),
  };
}

test("an account with a full weekly window waits for that window, so the next free account names the reset", async () => {
  const { rememberLimits, dropCachedLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  const { toGateError } = await import("@/lib/gateway/access/gate");
  const sessionA = Date.now() + 3_600_000;
  const weekA = Date.now() + 3 * 24 * 3_600_000;
  const sessionB = Date.now() + 2 * 3_600_000;
  rememberLimits("acct-a", sessionAndWeek(sessionA, weekA, 100));
  rememberLimits("acct-b", sessionAndWeek(sessionB, Date.now() + 4 * 24 * 3_600_000, 40));
  try {
    const resets = new Map([
      ["acct-a", sessionA],
      ["acct-b", sessionB],
    ]);
    const gate = toGateError(
      await route(async (dep) => {
        throw await limitError("Usage limit reached.", resets.get(dep.provider_id));
      }).catch((err: unknown) => err),
    );
    assert.equal(gate.status, 429);
    assert.equal(gate.code, "rate_limit_exceeded");
    assert.equal(gate.retryAt, sessionB);
  } finally {
    dropCachedLimits("acct-a");
    dropCachedLimits("acct-b");
  }
});

test("a limit answer without a reset waits for the window the account's limits report", async () => {
  const { rememberLimits, dropCachedLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  const { GateError } = await import("@/lib/gateway/errors");
  const { gateResponse } = await import("@/lib/gateway/access/gate");
  const sessionA = Date.now() + 90 * 60_000;
  rememberLimits("acct-a", sessionAndWeek(sessionA, Date.now() + 5 * 24 * 3_600_000, 30));
  rememberLimits("acct-b", sessionAndWeek(Date.now() + 4 * 3_600_000, Date.now() + 6 * 24 * 3_600_000, 30));
  try {
    const failure = await route(async () => {
      throw new GateError(429, "upstream_error", "Usage limit reached.", { upstreamCode: "usage_limit_reached" });
    }).catch((err: unknown) => err);
    const response = gateResponse(failure, new Request("http://hub.local/v1/responses", { method: "POST" }));
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(body.error.type, "usage_limit_reached");
    assert.equal(body.error.resets_at, Math.ceil(sessionA / 1000));
    assert.equal(response.headers.get("x-codex-primary-reset-at"), String(Math.ceil(sessionA / 1000)));
  } finally {
    dropCachedLimits("acct-a");
    dropCachedLimits("acct-b");
  }
});

test("accounts already cooling down after a limit answer with a rate limit error instead of overloaded", async () => {
  const { markFailure } = await import("@/lib/gateway/routing/runtime");
  const { gateResponse } = await import("@/lib/gateway/access/gate");
  const resetAt = Date.now() + 90 * 60_000;
  markFailure({ id: `${alias}-dep-a` } as ResolvedDeployment, resetAt + 60_000);
  markFailure({ id: `${alias}-dep-b` } as ResolvedDeployment, resetAt);
  const served: string[] = [];
  const failure = await route(async (dep) => {
    served.push(dep.provider_id);
    return "unreachable";
  }).catch((err: unknown) => err);
  assert.deepEqual(served, []);
  const response = gateResponse(failure, new Request("http://hub.local/v1/messages", { method: "POST" }));
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.type, "rate_limit_error");
  assert.match(body.error.message, /available again at /);
  assert.ok(Number(response.headers.get("retry-after")) > 60 * 60);
  assert.equal(response.headers.get("x-should-retry"), "false");
});

test("a short transient cooldown stays retryable and tells the client when to come back", async () => {
  const { markFailure } = await import("@/lib/gateway/routing/runtime");
  const { gateResponse, toGateError } = await import("@/lib/gateway/access/gate");
  for (const dep of ["dep-a", "dep-b"]) {
    markFailure({ id: `${alias}-${dep}` } as ResolvedDeployment);
    markFailure({ id: `${alias}-${dep}` } as ResolvedDeployment);
  }
  const failure = await route(async () => "unreachable").catch((err: unknown) => err);
  const gate = toGateError(failure);
  assert.equal(gate.status, 503);
  assert.equal(gate.code, "no_healthy_deployment");
  assert.ok(gate.retryAt && gate.retryAt > Date.now());
  const response = gateResponse(failure, new Request("http://hub.local/v1/chat/completions", { method: "POST" }));
  assert.ok(Number(response.headers.get("retry-after")) <= 15);
  assert.equal(response.headers.get("x-should-retry"), "true");
});

test("one limited account and one rejected login report the real upstream failure", async () => {
  const { GateError } = await import("@/lib/gateway/errors");
  const served: string[] = [];
  const failure = await route(async (dep) => {
    served.push(dep.provider_id);
    if (dep.provider_id === "acct-a") throw await limitError();
    throw new GateError(401, "upstream_error", "OAuth access token has been revoked.");
  }).catch((err: unknown) => err);
  assert.deepEqual(served, ["acct-a", "acct-b"]);
  assert.ok(failure instanceof GateError);
  assert.equal(failure.status, 401);
  assert.equal(failure.message, "OAuth access token has been revoked.");
});

test("an overflow group with free accounts takes over when the primary accounts are limited", async () => {
  const { markFailure } = await import("@/lib/gateway/routing/runtime");
  const primary = alias;
  const spare = `${primary}-spare`;
  groups.set(spare, groupRow(spare));
  groups.set(primary, groupRow(primary, 0, spare));
  markFailure({ id: `${primary}-dep-a` } as ResolvedDeployment, Date.now() + 3_600_000);
  markFailure({ id: `${primary}-dep-b` } as ResolvedDeployment, Date.now() + 3_600_000);
  const routed = await route(async (dep) => dep.id);
  assert.equal(routed.result, `${spare}-dep-a`);
});

test("limits across a group and its overflow report the earliest reset of either", async () => {
  const { markFailure } = await import("@/lib/gateway/routing/runtime");
  const { toGateError } = await import("@/lib/gateway/access/gate");
  const primary = alias;
  const spare = `${primary}-spare`;
  groups.set(spare, groupRow(spare));
  groups.set(primary, groupRow(primary, 0, spare));
  const earliest = Date.now() + 40 * 60_000;
  markFailure({ id: `${primary}-dep-a` } as ResolvedDeployment, Date.now() + 3_600_000);
  markFailure({ id: `${primary}-dep-b` } as ResolvedDeployment, Date.now() + 3_600_000);
  markFailure({ id: `${spare}-dep-a` } as ResolvedDeployment, earliest);
  markFailure({ id: `${spare}-dep-b` } as ResolvedDeployment, Date.now() + 2 * 3_600_000);
  const gate = toGateError(await route(async () => "unreachable").catch((err: unknown) => err));
  assert.equal(gate.status, 429);
  assert.equal(gate.retryAt, earliest);
});

test("a run stays on its account until that account fails", async () => {
  const { writePin } = await import("@/lib/gateway/routing/account-affinity");
  const { runSession } = await import("@/lib/gateway/routing/account-affinity");
  const request: JsonMap = { prompt_cache_key: "run-sticky", messages: [{ role: "user", content: "hi" }] };
  await writePin("codex", runSession(request), { providerId: "acct-b", handoffAt: 0 }, null);
  for (let i = 0; i < 3; i++) {
    const routed = await route(async () => "ok", request);
    assert.equal(routed.dep.provider_id, "acct-b");
  }
  const fresh = await route(async () => "ok", { prompt_cache_key: "run-other", messages: [] });
  assert.equal(fresh.dep.provider_id, "acct-a");
});

test("a Claude Code session stays on its account through metadata.user_id", async () => {
  const { runSession, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const request: JsonMap = {
    model: "m",
    metadata: { user_id: JSON.stringify({ device_id: "d", session_id: "claude-run" }) },
    messages: [{ role: "user", content: "hi" }],
  };
  assert.equal(runSession(request), runSession({ prompt_cache_key: "claude-code-claude-run" }));
  assert.equal(runSession({ metadata: { user_id: "plain-user" } }), "");
  await writePin("codex", runSession(request), { providerId: "acct-b", handoffAt: 0 }, null);
  for (let i = 0; i < 3; i++) {
    const routed = await route(async () => "ok", request);
    assert.equal(routed.dep.provider_id, "acct-b");
  }
  const other = await route(async () => "ok", { ...request, metadata: { user_id: JSON.stringify({ session_id: "other-run" }) } });
  assert.equal(other.dep.provider_id, "acct-a");
});

test("switching accounts mid-run hands the history over without the old account's encrypted reasoning", async () => {
  const { readPin, runSession, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const request: JsonMap = {
    prompt_cache_key: "run-handoff",
    messages: [
      { role: "user", content: "step 1" },
      { role: "assistant", content: "done 1", thinking_blocks: [{ type: "thinking", thinking: "", signature: "gAAAA-from-a" }] },
      { role: "user", content: "step 2" },
    ],
  };
  const session = runSession(request);
  await writePin("codex", session, { providerId: "acct-a", handoffAt: 0 }, null);
  const seen: string[][] = [];
  const routed = await route(async (dep) => {
    seen.push(reasoningOf(request));
    if (dep.provider_id === "acct-a") throw await limitError();
    return "continued";
  }, request);
  assert.equal(routed.dep.provider_id, "acct-b");
  assert.deepEqual(seen, [["gAAAA-from-a"], []]);
  assert.deepEqual((request.messages as JsonMap[]).map((message) => message.content), ["step 1", "done 1", "step 2"]);
  assert.deepEqual(await readPin("codex", session), { providerId: "acct-b", handoffAt: 3 });

  const later: JsonMap = {
    prompt_cache_key: "run-handoff",
    messages: [
      ...(request.messages as JsonMap[]).slice(0, 1),
      { role: "assistant", content: "done 1", thinking_blocks: [{ type: "thinking", thinking: "", signature: "gAAAA-from-a" }] },
      { role: "user", content: "step 2" },
      { role: "assistant", content: "done 2", thinking_blocks: [{ type: "thinking", thinking: "", signature: "gAAAA-from-b" }] },
      { role: "user", content: "step 3" },
    ],
  };
  const next = await route(async () => reasoningOf(later), later);
  assert.equal(next.dep.provider_id, "acct-b");
  assert.deepEqual(next.result, ["gAAAA-from-b"]);
});

test("a run whose account was paused continues on the next account without the old account's encrypted reasoning", async () => {
  const { readPin, runSession, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const request: JsonMap = {
    prompt_cache_key: "run-paused",
    messages: [
      { role: "user", content: "step 1" },
      { role: "assistant", content: "done 1", thinking_blocks: [{ type: "thinking", thinking: "", signature: "gAAAA-from-a" }] },
      { role: "user", content: "step 2" },
    ],
  };
  const session = runSession(request);
  await writePin("codex", session, { providerId: "acct-a", handoffAt: 0 }, null);
  groups.get(alias)!.deployments[0]!.provider.enabled = false;
  const served: string[] = [];
  const routed = await route(async (dep) => {
    served.push(`${dep.provider_id}:${reasoningOf(request).length}`);
    return "continued";
  }, request);
  assert.equal(routed.dep.provider_id, "acct-b");
  assert.deepEqual(served, ["acct-b:0"]);
  for (let wait = 0; wait < 20; wait++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await readPin("codex", session), { providerId: "acct-b", handoffAt: 3 });
});

test("an upstream that cannot verify carried reasoning gets the request again without it", async () => {
  const { GateError } = await import("@/lib/gateway/errors");
  const request: JsonMap = {
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b", thinking_blocks: [{ type: "thinking", thinking: "", signature: "gAAAA-foreign" }] },
      { role: "user", content: "c" },
    ],
  };
  const served: string[] = [];
  const routed = await route(async (dep) => {
    served.push(`${dep.provider_id}:${reasoningOf(request).length}`);
    if (reasoningOf(request).length) {
      throw new GateError(400, "upstream_error", "The encrypted content for item rs_1 could not be verified.");
    }
    return "ok";
  }, request);
  assert.equal(routed.result, "ok");
  assert.deepEqual(served, ["acct-a:1", "acct-a:0"]);
});

test("rejected credentials that cannot be renewed fail over to the next account", async () => {
  const { GateError } = await import("@/lib/gateway/errors");
  const served: string[] = [];
  const routed = await route(async (dep) => {
    served.push(dep.provider_id);
    if (dep.provider_id === "acct-a") throw new GateError(401, "upstream_error", "OAuth access token has been revoked.");
    return "ok";
  });
  assert.equal(routed.dep.provider_id, "acct-b");
  assert.deepEqual(served, ["acct-a", "acct-b"]);
});

test("errors that are the caller's fault do not switch accounts", async () => {
  const { GateError } = await import("@/lib/gateway/errors");
  const served: string[] = [];
  await assert.rejects(
    route(async (dep) => {
      served.push(dep.provider_id);
      throw new GateError(400, "upstream_error", "messages: field required");
    }),
    (err: unknown) => err instanceof GateError && err.status === 400,
  );
  assert.deepEqual(served, ["acct-a"]);
});
