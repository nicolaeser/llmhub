import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";

type FakeAccount = { id: string; deployment: string; weight: number };

const ACCOUNTS: FakeAccount[] = [
  { id: "acct-a", deployment: "dep-a", weight: 10 },
  { id: "acct-b", deployment: "dep-b", weight: 5 },
];

function groupRow(alias: string, numRetries = 0) {
  return {
    alias,
    enabled: true,
    strategy: "priority",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    priceWindows: [],
    overflowGroup: "",
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

async function limitError(message = "You've hit your usage limit.") {
  const { GateError } = await import("@/lib/gateway/errors");
  return new GateError(429, "upstream_error", message, { upstreamCode: "usage_limit_reached", retryAt: Date.now() + 3_600_000 });
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

test("when every account is exhausted the caller gets the upstream limit error, not a routing error", async () => {
  await assert.rejects(
    route(async () => {
      throw await limitError("Usage limit reached until 18:00.");
    }),
    (err: unknown) => err instanceof Error && err.message === "Usage limit reached until 18:00." && (err as { status?: number }).status === 429,
  );
});

test("a run stays on its account until that account fails", async () => {
  const { writePin } = await import("@/lib/gateway/routing/account-affinity");
  const { runSession } = await import("@/lib/gateway/routing/account-affinity");
  const request: JsonMap = { prompt_cache_key: "run-sticky", messages: [{ role: "user", content: "hi" }] };
  await writePin("codex", runSession(request), { providerId: "acct-b", handoffAt: 0 });
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
  await writePin("codex", runSession(request), { providerId: "acct-b", handoffAt: 0 });
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
  await writePin("codex", session, { providerId: "acct-a", handoffAt: 0 });
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
