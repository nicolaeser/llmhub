import { gateway, gatewayRequest, groupRow, resetGateway } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { seal } from "@/lib/crypto";
import { GateError } from "@/lib/gateway/errors";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment, ResolvedModelGroup, RunRouting } from "@/types/routing";

let counter = 0;

function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function provider(id: string, change: Record<string, unknown> = {}) {
  return {
    id,
    kind: "openai_compat",
    baseUrl: "",
    apiKey: "",
    zdr: false,
    retentionDays: null,
    region: "",
    noTraining: false,
    enabled: true,
    restricted: false,
    internal: false,
    maxConcurrency: null,
    adaptiveConcurrency: false,
    assignments: [],
    login: null,
    ...change,
  };
}

function replica(id: string, weight = 1, change: Record<string, unknown> = {}): ResolvedDeployment {
  return {
    id,
    kind: "openai_compat",
    base_url: "http://gpu.test/v1",
    model: "qwen",
    weight,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: id,
    provider: provider(id, change),
  };
}

function replicas(count: number, weights: number[] = []): ResolvedDeployment[] {
  const prefix = unique("gpu");
  return Array.from({ length: count }, (_, index) => replica(`${prefix}-${String.fromCharCode(97 + index)}`, weights[index] ?? 1));
}

function pool(strategy: string, sessionAffinity: boolean, mapped: ResolvedDeployment[]): ResolvedModelGroup {
  return {
    alias: unique("local-qwen"),
    strategy,
    billing_mode: "routed",
    price_input_per_1k: 0,
    price_output_per_1k: 0,
    price_time_zone: "UTC",
    price_windows: [],
    overflow_group: "",
    num_retries: 0,
    fallback_groups: [],
    deployments: mapped,
    mapped,
    session_affinity: sessionAffinity,
  };
}

async function run(session: string | null, tried: Set<string> = new Set()): Promise<RunRouting> {
  const { runAffinity } = await import("@/lib/gateway/routing/deployment-affinity");
  const headers = session === null ? undefined : { "x-session-affinity": session };
  return { session: "", tried, affinity: runAffinity(undefined, null, headers) };
}

async function acquire(group: ResolvedModelGroup, routing: RunRouting | null) {
  const { acquireGroup } = await import("@/lib/gateway/routing/runtime");
  return acquireGroup(group, undefined, undefined, "", undefined, null, routing);
}

async function served(group: ResolvedModelGroup, routing: RunRouting | null) {
  const got = await acquire(group, routing);
  got.release();
  return got;
}

async function pinOf(group: ResolvedModelGroup, routing: RunRouting): Promise<string | null> {
  const { groupSession, readDeploymentPin } = await import("@/lib/gateway/routing/deployment-affinity");
  return readDeploymentPin(group.alias, groupSession(group, routing));
}

beforeEach(async () => {
  const { forgetDeploymentPins } = await import("@/lib/gateway/routing/deployment-affinity");
  const { forgetPins } = await import("@/lib/gateway/routing/account-affinity");
  forgetDeploymentPins();
  forgetPins();
  resetGateway();
});

test("the first request of a session is placed by the group strategy and follow-ups stay on that replica", async () => {
  const [a, b] = replicas(2);
  const group = pool("least_inflight", true, [a!, b!]);
  const other = await acquire(group, null);
  assert.equal(other.dep.id, a!.id);
  assert.deepEqual(other.affinity, { outcome: "off", key: "" });

  const first = await served(group, await run("agent-1"));
  assert.equal(first.dep.id, b!.id);
  assert.equal(first.affinity?.outcome, "new");
  assert.match(first.affinity?.key ?? "", /^[0-9a-f]{32}$/);
  assert.equal(await pinOf(group, await run("agent-1")), b!.id);
  other.release();

  const holdB = await acquire(pool("priority", false, [b!]), null);
  const second = await served(group, await run("agent-1"));
  assert.equal(second.dep.id, b!.id);
  assert.equal(second.affinity?.outcome, "hit");
  assert.equal(second.affinity?.key, first.affinity?.key);
  holdB.release();
});

test("different sessions keep their own replica", async () => {
  const [a, b] = replicas(2);
  const group = pool("round_robin", true, [a!, b!]);
  const one = await served(group, await run("one"));
  const two = await served(group, await run("two"));
  assert.notEqual(one.dep.id, two.dep.id);
  for (let turn = 0; turn < 3; turn++) {
    assert.equal((await served(group, await run("one"))).dep.id, one.dep.id);
    assert.equal((await served(group, await run("two"))).dep.id, two.dep.id);
  }
});

test("without the flag the picks, the round-robin order, and the pin store are unchanged", async () => {
  const off = replicas(3);
  const offGroup = pool("round_robin", false, off);
  const picks: string[] = [];
  for (let turn = 0; turn < 4; turn++) {
    const got = await served(offGroup, await run("agent-off"));
    assert.equal(got.affinity, null);
    picks.push(got.dep.id);
  }
  assert.deepEqual(picks, [off[0]!.id, off[1]!.id, off[2]!.id, off[0]!.id]);
  assert.equal(await pinOf({ ...offGroup, session_affinity: true }, await run("agent-off")), null);

  const bare = replicas(3);
  const bareGroup = pool("round_robin", false, bare);
  const plain: string[] = [];
  for (let turn = 0; turn < 4; turn++) plain.push((await served(bareGroup, null)).dep.id);
  assert.deepEqual(plain, [bare[0]!.id, bare[1]!.id, bare[2]!.id, bare[0]!.id]);
});

test("with the flag but no session key the group strategy decides and the outcome is off", async () => {
  const deps = replicas(3);
  const group = pool("round_robin", true, deps);
  const picks: string[] = [];
  for (let turn = 0; turn < 4; turn++) {
    const got = await served(group, await run(null));
    assert.deepEqual(got.affinity, { outcome: "off", key: "" });
    picks.push(got.dep.id);
  }
  assert.deepEqual(picks, [deps[0]!.id, deps[1]!.id, deps[2]!.id, deps[0]!.id]);
});

test("a cooling replica fails over and the session moves with it", async () => {
  const { markFailure } = await import("@/lib/gateway/routing/runtime");
  const [a, b] = replicas(2, [10, 5]);
  const group = pool("priority", true, [a!, b!]);
  assert.equal((await served(group, await run("cool"))).dep.id, a!.id);
  markFailure(a!, Date.now() + 60_000);
  const moved = await served(group, await run("cool"));
  assert.equal(moved.dep.id, b!.id);
  assert.equal(moved.affinity?.outcome, "failover");
  assert.equal(await pinOf(group, await run("cool")), b!.id);
  const stays = await served(group, await run("cool"));
  assert.equal(stays.dep.id, b!.id);
  assert.equal(stays.affinity?.outcome, "hit");
});

test("a paused, removed, or already tried replica is never resurrected by the pin", async () => {
  const { writeDeploymentPin, groupSession } = await import("@/lib/gateway/routing/deployment-affinity");
  const [a, b] = replicas(2, [10, 5]);
  const group = pool("priority", true, [a!, b!]);

  const tried = await run("tried", new Set([a!.id]));
  await writeDeploymentPin(group.alias, groupSession(group, tried), a!.id);
  const skipped = await served(group, tried);
  assert.equal(skipped.dep.id, b!.id);
  assert.equal(skipped.affinity?.outcome, "failover");
  assert.equal(await pinOf(group, tried), b!.id);

  const gone = await run("gone");
  await writeDeploymentPin(group.alias, groupSession(group, gone), "removed-deployment");
  const replaced = await served(group, gone);
  assert.equal(replaced.dep.id, a!.id);
  assert.equal(replaced.affinity?.outcome, "failover");

  const paused = pool("priority", true, [replica(a!.id, 10, { enabled: false }), b!]);
  const pausedRun = await run("paused");
  await writeDeploymentPin(paused.alias, groupSession(paused, pausedRun), a!.id);
  const away = await served(paused, pausedRun);
  assert.equal(away.dep.id, b!.id);
  assert.equal(away.affinity?.outcome, "failover");
});

test("an overloaded replica spills the session to a quieter one and re-pins it", async () => {
  const { DEFAULT_SPILL_MARGIN } = await import("@/lib/gateway/routing/deployment-affinity");
  const [a, b] = replicas(2, [10, 5]);
  const group = pool("priority", true, [a!, b!]);
  const held = [await acquire(group, await run("hot"))];
  assert.equal(held[0]!.affinity?.outcome, "new");
  for (let turn = 0; turn < DEFAULT_SPILL_MARGIN; turn++) {
    const got = await acquire(group, await run("hot"));
    assert.equal(got.dep.id, a!.id);
    assert.equal(got.affinity?.outcome, "hit");
    held.push(got);
  }
  const spilled = await served(group, await run("hot"));
  assert.equal(spilled.dep.id, b!.id);
  assert.equal(spilled.affinity?.outcome, "spill");
  assert.equal(await pinOf(group, await run("hot")), b!.id);
  assert.equal((await served(group, await run("hot"))).affinity?.outcome, "hit");
  for (const got of held) got.release();
});

test("a replica without a free concurrency permit spills the session", async () => {
  const prefix = unique("busy");
  const a = replica(`${prefix}-a`, 10, { maxConcurrency: 1 });
  const b = replica(`${prefix}-b`, 5);
  const group = pool("priority", true, [a, b]);
  const holding = await acquire(group, await run("busy"));
  assert.equal(holding.dep.id, a.id);
  const spilled = await served(group, await run("busy"));
  assert.equal(spilled.dep.id, b.id);
  assert.equal(spilled.affinity?.outcome, "spill");
  holding.release();
  assert.equal((await served(group, await run("busy"))).dep.id, b.id);
});

test("pins slide: every hit restarts the thirty minute window", async () => {
  const { DEPLOYMENT_PIN_TTL_MS, readDeploymentPin, touchDeploymentPin, writeDeploymentPin } = await import(
    "@/lib/gateway/routing/deployment-affinity"
  );
  const start = 1_000_000;
  await writeDeploymentPin("alias", "session", "dep-1", start);
  assert.equal(await readDeploymentPin("alias", "session", start + DEPLOYMENT_PIN_TTL_MS - 1), "dep-1");
  await touchDeploymentPin("alias", "session", "dep-1", start + 20 * 60_000);
  assert.equal(await readDeploymentPin("alias", "session", start + 45 * 60_000), "dep-1");
  assert.equal(await readDeploymentPin("alias", "session", start + 20 * 60_000 + DEPLOYMENT_PIN_TTL_MS), null);

  const [a, b] = replicas(2, [10, 5]);
  const group = pool("priority", true, [a!, b!]);
  const routing = await run("sliding");
  const { groupSession } = await import("@/lib/gateway/routing/deployment-affinity");
  await writeDeploymentPin(group.alias, groupSession(group, routing), b!.id, Date.now() - 25 * 60_000);
  assert.equal((await served(group, routing)).affinity?.outcome, "hit");
  assert.equal(await readDeploymentPin(group.alias, groupSession(group, routing), Date.now() + 20 * 60_000), b!.id);
});

test("a retry after an upstream failure moves the pin to the replica that answered", async () => {
  const { withDeployment } = await import("@/lib/gateway/dispatch/chat");
  const alias = unique("retry");
  const prefix = unique("retry-gpu");
  gateway.groups.set(
    alias,
    groupRow(alias, {
      strategy: "priority",
      numRetries: 1,
      sessionAffinity: true,
      deployments: ["a", "b"].map((name, index) => ({
        id: `${prefix}-${name}`,
        kind: "openai_compat",
        baseUrl: "http://gpu.test/v1",
        model: "qwen",
        weight: 10 - index,
        costInput: 0,
        costOutput: 0,
        providerId: null,
        provider: null,
      })),
    }),
  );
  const request: JsonMap = { model: alias, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] };
  const attempts: string[] = [];
  const routed = await withDeployment(
    [alias],
    {},
    async (dep) => {
      attempts.push(dep.id);
      if (dep.id.endsWith("-a")) throw new GateError(503, "upstream_error", "replica restarting");
      return dep.id;
    },
    { request },
  );
  assert.deepEqual(attempts, [`${prefix}-a`, `${prefix}-b`]);
  const { servedAffinity, readDeploymentPin } = await import("@/lib/gateway/routing/deployment-affinity");
  assert.equal(servedAffinity(routed.dep)?.outcome, "failover");
  assert.equal(await readDeploymentPin(alias, servedAffinity(routed.dep)!.key), `${prefix}-b`);
});

function account(id: string, weight: number, enabled = true) {
  return { id, weight, enabled };
}

async function accountScenario(sessionAffinity: boolean) {
  const { withDeployment } = await import("@/lib/gateway/dispatch/chat");
  const { forgetPins, readPin, runSession } = await import("@/lib/gateway/routing/account-affinity");
  const { servedAffinity } = await import("@/lib/gateway/routing/deployment-affinity");
  forgetPins();
  const alias = unique(`accounts-${sessionAffinity}`);
  const accounts = new Map([account("acct-a", 10), account("acct-b", 5)].map((entry) => [entry.id, entry]));
  const row = () =>
    groupRow(alias, {
      vendor: "anthropic",
      sessionAffinity,
      deployments: [...accounts.values()].map((entry) => ({
        id: `${alias}-${entry.id}`,
        kind: "claude",
        baseUrl: "",
        model: "claude-test",
        weight: entry.weight,
        costInput: 0,
        costOutput: 0,
        providerId: `${alias}-${entry.id}`,
        provider: { ...provider(`${alias}-${entry.id}`, { kind: "claude", enabled: entry.enabled, login: { status: "active" } }) },
      })),
    });
  recordedPrisma.handlers = {
    modelGroup: { findUnique: ({ where }: { where: { alias: string } }) => (where.alias === alias ? row() : null) },
  };
  const claudeCode = (session: string, turns: number): JsonMap => ({
    model: alias,
    metadata: { user_id: JSON.stringify({ device_id: "d", session_id: session }) },
    messages: Array.from({ length: turns * 2 - 1 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `turn ${index}`,
    })),
  });
  const outcomes: string[] = [];
  const route = async (request: JsonMap) => {
    const routed = await withDeployment([alias], {}, async (dep) => dep.provider_id.slice(alias.length + 1), {
      pool: "subscription",
      request,
    });
    outcomes.push(servedAffinity(routed.dep)?.outcome ?? "");
    return routed.result;
  };
  const settle = async () => {
    for (let wait = 0; wait < 20; wait++) await new Promise((resolve) => setImmediate(resolve));
  };
  const results: string[] = [];
  const pins: (string | undefined)[] = [];
  const record = async (request: JsonMap) => {
    results.push(await route(request));
    await settle();
    pins.push((await readPin("claude", runSession(request)))?.providerId.slice(alias.length + 1));
  };
  await record(claudeCode("run", 1));
  accounts.get("acct-a")!.enabled = false;
  await record(claudeCode("run", 2));
  accounts.get("acct-a")!.enabled = true;
  await record(claudeCode("run", 3));
  await record(claudeCode("other", 1));
  return { results, pins, outcomes };
}

test("subscription account pinning picks the same accounts with and without session affinity", async () => {
  const without = await accountScenario(false);
  assert.deepEqual(without.results, ["acct-a", "acct-b", "acct-b", "acct-a"]);
  assert.deepEqual(without.pins, ["acct-a", "acct-b", "acct-b", "acct-a"]);
  assert.deepEqual(without.outcomes, ["", "", "", ""]);
  const affine = await accountScenario(true);
  assert.deepEqual(affine.results, without.results);
  assert.deepEqual(affine.pins, without.pins);
  assert.deepEqual(affine.outcomes, ["new", "failover", "hit", "new"]);
});

function affinityGroup(sessionAffinity: boolean, kind = "openai_compat"): string {
  const alias = unique(kind === "anthropic" ? "claude-local" : "qwen-local");
  gateway.groups.set(
    alias,
    groupRow(alias, {
      vendor: kind === "anthropic" ? "anthropic" : "openai",
      sessionAffinity,
      deployments: [
        {
          id: `${alias}-route`,
          kind,
          baseUrl: kind === "anthropic" ? "https://anthropic.upstream.test" : "https://gpu.upstream.test/v1",
          model: "served-model",
          weight: 1,
          costInput: 0,
          costOutput: 0,
          providerId: kind === "anthropic" ? `${alias}-key` : null,
          provider:
            kind === "anthropic"
              ? { ...provider(`${alias}-key`, { kind: "anthropic", apiKey: seal("sk-ant-test") }), internal: false }
              : null,
        },
      ],
    }),
  );
  return alias;
}

function stream(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const CHAT_FRAMES = [
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  "data: [DONE]\n\n",
];

function anthropicFrame(type: string, data: JsonMap): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const MESSAGE_FRAMES = [
  anthropicFrame("message_start", {
    message: { id: "msg_1", type: "message", role: "assistant", model: "served-model", content: [], usage: { input_tokens: 4, output_tokens: 1 } },
  }),
  anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  anthropicFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }),
  anthropicFrame("content_block_stop", { index: 0 }),
  anthropicFrame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
  anthropicFrame("message_stop", {}),
];

async function loggedAffinity(): Promise<{ affinity: string; affinityKey: string }[]> {
  for (let wait = 0; wait < 400 && !recordedPrisma.called("requestLog", "create").length; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return recordedPrisma
    .called("requestLog", "create")
    .map((call) => (call.args as { data: { affinity: string; affinityKey: string } }).data)
    .map(({ affinity, affinityKey }) => ({ affinity, affinityKey }));
}

type Surface = {
  name: string;
  kind?: string;
  load: () => Promise<{ POST: (req: Request) => Promise<Response> }>;
  path: string;
  body: (alias: string) => JsonMap;
  reply: () => Response;
  expect: RegExp;
};

const SURFACES: Surface[] = [
  {
    name: "streaming chat completions",
    load: () => import("@/app/api/v1/chat/completions/route"),
    path: "/api/v1/chat/completions",
    body: (alias) => ({ model: alias, stream: true, messages: [{ role: "user", content: "hi" }] }),
    reply: () => stream(CHAT_FRAMES),
    expect: /data: \[DONE\]/,
  },
  {
    name: "chat completions",
    load: () => import("@/app/api/v1/chat/completions/route"),
    path: "/api/v1/chat/completions",
    body: (alias) => ({ model: alias, messages: [{ role: "user", content: "hi" }] }),
    reply: () =>
      Response.json({
        id: "c1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    expect: /"content":"Hi"/,
  },
  {
    name: "streaming Anthropic messages",
    kind: "anthropic",
    load: () => import("@/app/api/v1/messages/route"),
    path: "/api/v1/messages",
    body: (alias) => ({ model: alias, max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
    reply: () => stream(MESSAGE_FRAMES),
    expect: /event: message_stop/,
  },
  {
    name: "streaming responses",
    load: () => import("@/app/api/v1/responses/route"),
    path: "/api/v1/responses",
    body: (alias) => ({ model: alias, input: "hi", stream: true, store: false }),
    reply: () => stream(CHAT_FRAMES),
    expect: /response\.completed/,
  },
  {
    name: "embeddings",
    load: () => import("@/app/api/v1/embeddings/route"),
    path: "/api/v1/embeddings",
    body: (alias) => ({ model: alias, input: "hi" }),
    reply: () => Response.json({ object: "list", data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 } }),
    expect: /"embedding"/,
  },
];

for (const surface of SURFACES) {
  test(`${surface.name} relays unchanged and names the deployment only when the group has session affinity`, async () => {
    const { POST } = await surface.load();
    for (const sessionAffinity of [false, true]) {
      resetGateway();
      const alias = affinityGroup(sessionAffinity, surface.kind);
      gateway.reply = surface.reply;
      const res = await POST(
        gatewayRequest(surface.path, surface.body(alias), { "x-session-affinity": "agent-7", "anthropic-version": "2023-06-01" }),
      );
      assert.equal(res.status, 200, await res.clone().text());
      assert.match(await res.text(), surface.expect);
      assert.equal(res.headers.get("x-llmhub-deployment"), sessionAffinity ? `${alias}-route` : null);
      assert.equal(gateway.upstream.length, 1);
      assert.equal(gateway.upstream[0]!.headers["x-session-affinity"], undefined);
      const [log] = await loggedAffinity();
      if (sessionAffinity) {
        assert.equal(log?.affinity, "new");
        assert.match(log?.affinityKey ?? "", /^[0-9a-f]{32}$/);
      } else {
        assert.deepEqual(log, { affinity: "", affinityKey: "" });
      }
    }
  });
}

test("the second turn of a conversation is a logged hit on the same deployment", async () => {
  const { POST } = await import("@/app/api/v1/chat/completions/route");
  const alias = affinityGroup(true);
  const turn = (messages: JsonMap[]) =>
    POST(gatewayRequest("/api/v1/chat/completions", { model: alias, messages: [{ role: "system", content: "You are terse." }, ...messages] }));
  await (await turn([{ role: "user", content: "fix the bug" }])).text();
  const [first] = await loggedAffinity();
  recordedPrisma.calls.length = 0;
  const res = await turn([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: "done" },
    { role: "user", content: "now add a test" },
  ]);
  await res.text();
  assert.equal(res.headers.get("x-llmhub-deployment"), `${alias}-route`);
  const [second] = await loggedAffinity();
  assert.equal(first?.affinity, "new");
  assert.equal(second?.affinity, "hit");
  assert.equal(second?.affinityKey, first?.affinityKey);
});
