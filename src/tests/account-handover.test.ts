import { gatewayRequest, resetGateway } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { sealTokens } from "@/lib/gateway/upstreams/credentials";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment, ResolvedModelGroup } from "@/types/routing";

type Account = { id: string; kind: string; weight: number; enabled: boolean; status: string; token: string; version: number };

const accounts = new Map<string, Account>();
let alias = "";
let counter = 0;

function account(id: string, weight: number, kind = "claude"): Account {
  return { id, kind, weight, enabled: true, status: "active", token: `${id}-token-1`, version: 0 };
}

function routeId(providerId: string): string {
  return `${alias}-${providerId}`;
}

function deploymentRow(entry: Account) {
  return {
    id: routeId(entry.id),
    kind: entry.kind,
    baseUrl: "",
    model: "claude-test",
    weight: entry.weight,
    costInput: 0,
    costOutput: 0,
    providerId: entry.id,
    provider: {
      id: entry.id,
      kind: entry.kind,
      baseUrl: "",
      apiKey: "",
      zdr: false,
      retentionDays: null,
      region: "",
      noTraining: false,
      enabled: entry.enabled,
      restricted: false,
      assignments: [],
      login: { status: entry.status },
    },
  };
}

function groupRow() {
  return {
    alias,
    enabled: true,
    vendor: "anthropic",
    displayName: "",
    strategy: "priority",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    priceWindows: [],
    overflowGroup: "",
    numRetries: 0,
    fallbackGroups: [],
    autoRoutes: null,
    deployments: [...accounts.values()].map(deploymentRow),
  };
}

function loginRow(providerId: string) {
  const entry = accounts.get(providerId);
  if (!entry) return null;
  return {
    providerId,
    account: `${providerId}@example.test`,
    plan: "max",
    tokens: sealTokens({ access: entry.token, refresh: `${providerId}-refresh`, accountId: "", residency: "" }),
    expiresAt: new Date(Date.now() + 3_600_000),
    status: entry.status,
    version: entry.version,
    refreshedAt: null,
    retryAt: null,
    failures: 0,
  };
}

const realFetch = globalThis.fetch;
const sent: { providerId: string; authorization: string }[] = [];
const streams = new Map<string, () => Response>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.includes("/v1/messages")) return realFetch(input, init);
  const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
  const owner = [...accounts.values()].find((entry) => authorization === `Bearer ${entry.token}`);
  sent.push({ providerId: owner?.id ?? "", authorization });
  const reply = owner ? streams.get(owner.id) : undefined;
  return reply ? reply() : new Response("unknown token", { status: 401 });
}) as typeof fetch;

function setup(...entries: Account[]) {
  resetGateway();
  counter += 1;
  alias = `handover-${counter}`;
  accounts.clear();
  for (const entry of entries) accounts.set(entry.id, entry);
  sent.length = 0;
  streams.clear();
  recordedPrisma.handlers = {
    modelGroup: { findUnique: ({ where }: { where: { alias: string } }) => (where.alias === alias ? groupRow() : null) },
    providerLogin: { findUnique: ({ where }: { where: { providerId: string } }) => loginRow(where.providerId) },
    deployment: {
      findMany: ({ where }: { where: { providerId: string } }) =>
        accounts.has(where.providerId) ? [{ id: routeId(where.providerId) }] : [],
    },
  };
}

function claudeCode(session: string, turns = 1): JsonMap {
  const messages: JsonMap[] = [];
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ role: "user", content: `step ${turn}` });
    if (turn < turns - 1) messages.push({ role: "assistant", content: `done ${turn}` });
  }
  return { model: alias, metadata: { user_id: JSON.stringify({ device_id: "d", session_id: session }) }, messages };
}

async function route(request: JsonMap, serve: (dep: ResolvedDeployment) => Promise<string> = async (dep) => dep.provider_id) {
  const { withDeployment } = await import("@/lib/gateway/dispatch/chat");
  return withDeployment([alias], {}, serve, { pool: "subscription", request });
}

async function pinOf(request: JsonMap) {
  const { readPin, runSession } = await import("@/lib/gateway/routing/account-affinity");
  for (let wait = 0; wait < 20; wait++) await new Promise((resolve) => setImmediate(resolve));
  return readPin("claude", runSession(request));
}

beforeEach(async () => {
  const { forgetPins } = await import("@/lib/gateway/routing/account-affinity");
  forgetPins();
});

test("a session on a paused account moves to the next account and stays there after the resume", async () => {
  setup(account("acct-a", 10), account("acct-b", 5));
  const first = claudeCode("paused-run");
  assert.equal((await route(first)).result, "acct-a");
  assert.deepEqual(await pinOf(first), { providerId: "acct-a", handoffAt: 0 });

  accounts.get("acct-a")!.enabled = false;
  const later = claudeCode("paused-run", 2);
  assert.equal((await route(later)).result, "acct-b");
  assert.deepEqual(await pinOf(later), { providerId: "acct-b", handoffAt: 3 });

  accounts.get("acct-a")!.enabled = true;
  assert.equal((await route(claudeCode("paused-run", 3))).result, "acct-b");
  assert.equal((await route(claudeCode("new-run"))).result, "acct-a");
});

test("a deleted account hands its sessions to the remaining account", async () => {
  setup(account("acct-a", 10), account("acct-b", 5));
  const request = claudeCode("deleted-run");
  assert.equal((await route(request)).result, "acct-a");
  accounts.delete("acct-a");
  const served: string[] = [];
  const routed = await route(claudeCode("deleted-run", 2), async (dep) => {
    served.push(dep.provider_id);
    return dep.provider_id;
  });
  assert.equal(routed.result, "acct-b");
  assert.deepEqual(served, ["acct-b"]);
  assert.deepEqual(await pinOf(request), { providerId: "acct-b", handoffAt: 3 });
});

test("an account whose sign-in expired is skipped without an upstream attempt", async () => {
  setup(account("acct-a", 10), account("acct-b", 5));
  const request = claudeCode("expired-run");
  assert.equal((await route(request)).result, "acct-a");
  accounts.get("acct-a")!.status = "expired";
  const served: string[] = [];
  const serve = async (dep: ResolvedDeployment) => {
    served.push(dep.provider_id);
    return dep.provider_id;
  };
  assert.equal((await route(claudeCode("expired-run", 2), serve)).result, "acct-b");
  assert.deepEqual(served, ["acct-b"]);
  assert.equal((await pinOf(request))?.providerId, "acct-b");

  accounts.get("acct-b")!.status = "expired";
  const { toGateError } = await import("@/lib/gateway/access/gate");
  const failure = toGateError(await route(claudeCode("expired-run", 3), serve).catch((err: unknown) => err));
  assert.deepEqual(served, ["acct-b"]);
  assert.equal(failure.status, 503);
  assert.equal(failure.code, "no_provider_key");
  assert.match(failure.message, /sign in again/);
});

test("a session leaves an account at its usage limit and new sessions return once the account is reactivated", async () => {
  setup(account("acct-a", 10), account("acct-b", 5));
  const { markFailure } = await import("@/lib/gateway/routing/runtime");
  const { reactivateAccount } = await import("@/lib/gateway/routing/account-reactivation");
  const request = claudeCode("limited-run");
  assert.equal((await route(request)).result, "acct-a");

  markFailure({ id: routeId("acct-a") } as ResolvedDeployment, Date.now() + 3_600_000);
  assert.equal((await route(claudeCode("limited-run", 2))).result, "acct-b");
  assert.equal((await route(claudeCode("fresh-run"))).result, "acct-b");

  await reactivateAccount("acct-a");
  assert.equal((await route(claudeCode("limited-run", 3))).result, "acct-b");
  assert.equal((await route(claudeCode("another-run"))).result, "acct-a");
  const backoff = recordedPrisma.called("providerLogin", "updateMany");
  assert.equal(backoff.length, 1);
  const { where, data } = backoff[0]!.args as { where: { providerId: string; status: string }; data: Record<string, unknown> };
  assert.equal(where.providerId, "acct-a");
  assert.equal(where.status, "active");
  assert.deepEqual(data, { retryAt: null, failures: 0 });
});

test("a session whose account is gone stays on the same kind of account when the model also routes elsewhere", async () => {
  setup(account("acct-a", 10), account("acct-b", 1), account("acct-codex", 100, "codex"));
  const { runSession, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const request = claudeCode("kind-run", 2);
  await writePin("claude", runSession(request), { providerId: "acct-a", handoffAt: 0 }, null);
  accounts.get("acct-a")!.enabled = false;
  assert.equal((await route(request)).result, "acct-b");
  assert.deepEqual(await pinOf(request), { providerId: "acct-b", handoffAt: 3 });
  assert.equal((await route(claudeCode("unpinned-run"))).result, "acct-codex");
});

test("concurrent handovers of one session settle on the account that moved it first", async () => {
  const { readPin, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const session = "race-session";
  const pinned = await writePin("claude", session, { providerId: "acct-a", handoffAt: 0 }, null);
  assert.deepEqual(pinned, { providerId: "acct-a", handoffAt: 0 });
  assert.deepEqual(await writePin("claude", session, { providerId: "acct-b", handoffAt: 4 }, pinned), {
    providerId: "acct-b",
    handoffAt: 4,
  });
  assert.deepEqual(await writePin("claude", session, { providerId: "acct-c", handoffAt: 4 }, pinned), {
    providerId: "acct-b",
    handoffAt: 4,
  });
  assert.deepEqual(await writePin("claude", session, { providerId: "acct-b", handoffAt: 6 }, pinned), {
    providerId: "acct-b",
    handoffAt: 6,
  });
  assert.deepEqual(await writePin("claude", session, { providerId: "acct-a", handoffAt: 0 }, null), {
    providerId: "acct-b",
    handoffAt: 6,
  });
  assert.deepEqual(await readPin("claude", session), { providerId: "acct-b", handoffAt: 6 });
});

test("releasing a finished request twice does not undercount the in-flight load", async () => {
  const { acquireGroup } = await import("@/lib/gateway/routing/runtime");
  const route = (id: string): ResolvedDeployment => ({
    id: `inflight-${id}`,
    kind: "openrouter",
    base_url: "",
    model: "m",
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: id,
  });
  const mapped = [route("one"), route("two")];
  const group: ResolvedModelGroup = {
    alias: "inflight",
    strategy: "least_inflight",
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
  };
  const first = await acquireGroup(group, undefined);
  const second = await acquireGroup(group, undefined);
  const third = await acquireGroup(group, undefined);
  assert.deepEqual([first.dep.id, second.dep.id, third.dep.id], ["inflight-one", "inflight-two", "inflight-one"]);
  first.release();
  first.release();
  second.release();
  const next = await acquireGroup(group, undefined);
  assert.equal(next.dep.id, "inflight-two");
  for (const held of [third, next]) held.release();
});

function anthropicStream(parts: string[], hold: Promise<void> = Promise.resolve()): Response {
  const frame = (type: string, body: JsonMap) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
  const head = [
    frame("message_start", {
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], usage: { input_tokens: 5, output_tokens: 0 } },
    }),
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: parts[0] } }),
  ];
  const tail = [
    ...parts.slice(1).map((text) => frame("content_block_delta", { index: 0, delta: { type: "text_delta", text } })),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
    frame("message_stop", {}),
  ];
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of head) controller.enqueue(encoder.encode(chunk));
        await hold;
        for (const chunk of tail) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(needle)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test("a stream that started before its account was paused and renewed finishes on its original token", { timeout: 10_000 }, async () => {
  setup(account("acct-a", 10), account("acct-b", 5));
  const { POST } = await import("@/app/api/subscription/v1/messages/route");
  let finish: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  streams.set("acct-a", () => anthropicStream(["first half", " second half"], held));
  streams.set("acct-b", () => anthropicStream(["from b"]));
  const ask = (session: string) =>
    POST(gatewayRequest("/api/subscription/v1/messages", { ...claudeCode(session), max_tokens: 64, stream: true }));

  const running = await ask("stream-run");
  assert.equal(running.status, 200);
  const reader = running.body!.getReader();
  const opened = await readUntil(reader, "first half");
  assert.match(opened, /first half/);

  const paused = accounts.get("acct-a")!;
  paused.enabled = false;
  paused.token = "acct-a-token-2";
  paused.version = 1;

  const moved = await ask("stream-run");
  assert.match(await moved.text(), /from b/);

  finish();
  const rest = await readUntil(reader, "message_stop");
  assert.match(rest, /second half/);
  assert.match(rest, /message_stop/);

  paused.enabled = true;
  streams.set("acct-a", () => anthropicStream(["renewed"]));
  assert.match(await (await ask("stream-run")).text(), /from b/);
  assert.match(await (await ask("other-run")).text(), /renewed/);

  assert.deepEqual(sent, [
    { providerId: "acct-a", authorization: "Bearer acct-a-token-1" },
    { providerId: "acct-b", authorization: "Bearer acct-b-token-1" },
    { providerId: "acct-b", authorization: "Bearer acct-b-token-1" },
    { providerId: "acct-a", authorization: "Bearer acct-a-token-2" },
  ]);
});
