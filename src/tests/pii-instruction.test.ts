import {
  chatReply,
  gateway,
  gatewayRequest,
  groupRow,
  MODEL,
  resetGateway,
  setKeyOverride,
  setOverride,
  UPSTREAM,
} from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import { setRequest } from "./support/next-headers-stub";
import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import { seal } from "@/lib/crypto";
import { defaultGuardrails } from "@/lib/gateway/safety/guardrails";
import {
  needsPiiInstruction,
  PII_RESTORE_INSTRUCTION,
  withChatPiiInstruction,
  withMessagesPiiInstruction,
} from "@/lib/gateway/safety/pii-instruction";
import { bindPiiVault, PiiVault } from "@/lib/gateway/safety/pii-vault";
import type { JsonMap, Principal, RequestTrace } from "@/types/gateway";
import type { PiiMode, PiiPolicy } from "@/types/guardrails";
import type { VirtualKeyView } from "@/types/keys";

const EMAIL = "ada@acme.com";
const TOKEN = "[EMAIL_ADDRESS_1]";
const INSTRUCTION = PII_RESTORE_INSTRUCTION;
const ENTITIES = ["EMAIL_ADDRESS", "SECRET"];
const CACHED_RULES = { type: "text", text: "Cached rules", cache_control: { type: "ephemeral" } };

function policy(mode: PiiMode, enabled = true): PiiPolicy {
  return { enabled, mode, output: false, entities: ENTITIES, detector: "patterns", failure: "patterns" };
}

function withPolicy(pii: PiiPolicy): void {
  resetGateway();
  gateway.key = { ...gateway.key, logContent: true };
  setKeyOverride({ pii });
  recordedPrisma.handlers = {
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        where.id === gateway.key.userId
          ? {
              id: where.id,
              blocked: false,
              orgId: null,
              spend: 0,
              maxBudget: 0,
              budgetDuration: "",
              spendResetAt: null,
              createdAt: new Date(0),
              logContent: true,
            }
          : null,
    },
  };
}

function withGroup(alias: string, deployments: JsonMap[]): void {
  gateway.groups.set(alias, groupRow(alias, { numRetries: deployments.length - 1, deployments }));
}

function anthropicRoute(id: string): JsonMap {
  return {
    id,
    kind: "anthropic",
    baseUrl: UPSTREAM,
    model: "claude-sonnet-4-6",
    weight: 1,
    costInput: 0,
    costOutput: 0,
    providerId: `provider-${id}`,
    provider: {
      id: `provider-${id}`,
      kind: "anthropic",
      baseUrl: UPSTREAM,
      apiKey: seal("sk-ant-test"),
      zdr: false,
      retentionDays: null,
      region: "",
      noTraining: false,
      enabled: true,
      restricted: false,
      assignments: [],
    },
  };
}

function compatRoute(id: string): JsonMap {
  return {
    id,
    kind: "openai_compat",
    baseUrl: UPSTREAM,
    model: MODEL,
    weight: 1,
    costInput: 0,
    costOutput: 0,
    providerId: null,
    provider: null,
  };
}

function sseResponse(frames: string[]): Response {
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

function anthropicEvent(type: string, payload: JsonMap): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function sseEvents(text: string): JsonMap[] {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "")
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data) as JsonMap);
}

function upstreamBody(index = 0): JsonMap {
  const body = gateway.upstream[index]?.body;
  assert.ok(body, `upstream call ${index} carried a JSON body`);
  return body;
}

function instructionCount(value: unknown): number {
  return JSON.stringify(value).split(INSTRUCTION.slice(0, 60)).length - 1;
}

function loggedRequests(): unknown[] {
  return recordedPrisma
    .called("requestLog", "create")
    .map((call) => (call.args as { data: { content?: { create: { request?: unknown } } } }).data.content?.create.request);
}

async function post(path: string, body: JsonMap): Promise<Response> {
  const routes: Record<string, () => Promise<{ POST(req: Request): Promise<Response> }>> = {
    "/api/v1/chat/completions": () => import("@/app/api/v1/chat/completions/route"),
    "/api/v1/completions": () => import("@/app/api/v1/completions/route"),
    "/api/v1/embeddings": () => import("@/app/api/v1/embeddings/route"),
    "/api/v1/messages": () => import("@/app/api/v1/messages/route"),
    "/api/v1/responses": () => import("@/app/api/v1/responses/route"),
  };
  const load = routes[path];
  assert.ok(load, path);
  const { POST } = await load();
  return POST(gatewayRequest(path, body));
}

function traceFor(endpoint: string, mode: PiiMode | "", values: [string, string][]): RequestTrace {
  const trace: RequestTrace = {
    endpoint,
    piiMode: mode,
    piiInput: new Set(),
    piiOutput: new Set(),
    guardInput: new Set(),
    guardOutput: new Set(),
    guardBlocked: false,
  };
  const vault = new PiiVault();
  for (const [id, value] of values) vault.placeholder(id, value);
  bindPiiVault(trace, vault);
  return trace;
}

function ownerPrincipal(pii: PiiPolicy): Principal {
  setOverride({ keyId: "key_batch" }, { pii, guardrails: defaultGuardrails() });
  const key: VirtualKeyView = {
    token_id: "key_batch",
    key_name: "sk-hub-batch",
    key_alias: "batch",
    user_id: "",
    team_id: "",
    org_id: "",
    project_id: "",
    member_id: "",
    models: [],
    templates: [],
    max_budget: 0,
    spend: 0,
    rpm_limit: 0,
    tpm_limit: 0,
    max_request_cost: 0,
    budget_duration: "",
    expires: "",
    allowed_ips: [],
    allowed_endpoints: [],
    access_windows: [],
    access_time_zone: "UTC",
    blocked: false,
    log_content: false,
    created_at: "",
  };
  return {
    actor: key.key_name,
    key,
    teamId: "",
    orgId: "",
    userId: "",
    memberId: "",
    models: [],
    routeLimits: {},
  };
}

test("chat bodies get the instruction at the end of the leading system message", () => {
  const user = { role: "user", content: `Mail ${TOKEN}` };
  const plain = withChatPiiInstruction({ model: MODEL, messages: [{ role: "system", content: "Be brief." }, user] });
  assert.deepEqual(plain.messages, [{ role: "system", content: `Be brief.\n\n${INSTRUCTION}` }, user]);

  const parts = withChatPiiInstruction({ model: MODEL, messages: [{ role: "developer", content: [CACHED_RULES] }, user] });
  assert.deepEqual(parts.messages, [
    { role: "developer", content: [CACHED_RULES, { type: "text", text: `\n\n${INSTRUCTION}` }] },
    user,
  ]);

  const bare = withChatPiiInstruction({ model: MODEL, messages: [user, { role: "system", content: "Late note" }] });
  assert.deepEqual((bare.messages as JsonMap[])[0], { role: "system", content: INSTRUCTION });
  assert.equal((bare.messages as JsonMap[]).length, 3);

  assert.deepEqual(withChatPiiInstruction(plain), plain);
  assert.deepEqual(withChatPiiInstruction(parts), parts);
  const sent = { model: MODEL, messages: [{ role: "system", content: INSTRUCTION }, user] };
  assert.equal(withChatPiiInstruction(sent), sent);
  const noMessages = { model: MODEL, prompt: "x" };
  assert.equal(withChatPiiInstruction(noMessages), noMessages);
});

test("Anthropic system prompts get the instruction last without touching client cache breakpoints", () => {
  const text = withMessagesPiiInstruction({ model: MODEL, system: "Be brief.", messages: [] });
  assert.equal(text.system, `Be brief.\n\n${INSTRUCTION}`);

  const blocks = withMessagesPiiInstruction({ model: MODEL, system: [CACHED_RULES], messages: [] });
  assert.deepEqual(blocks.system, [CACHED_RULES, { type: "text", text: INSTRUCTION }]);

  const absent = withMessagesPiiInstruction({ model: MODEL, messages: [] });
  assert.equal(absent.system, INSTRUCTION);

  assert.deepEqual(withMessagesPiiInstruction(text), text);
  assert.deepEqual(withMessagesPiiInstruction(blocks), blocks);
  assert.deepEqual(withMessagesPiiInstruction(absent), absent);
});

test("the instruction is due only in restore mode with a restorable placeholder on conversational endpoints", () => {
  const email: [string, string][] = [["EMAIL_ADDRESS", EMAIL]];
  for (const endpoint of [
    "/api/v1/chat/completions",
    "/api/v1/responses",
    "/api/v1/messages",
    "/api/subscription/v1/chat/completions",
    "/api/subscription/v1/responses",
    "/api/subscription/v1/messages",
    "/internal-api/playground/chat",
    "batch:/v1/chat/completions",
    "batch:/v1/responses",
  ]) {
    assert.equal(needsPiiInstruction(traceFor(endpoint, "restore", email)), true, endpoint);
  }
  for (const endpoint of [
    "/api/v1/completions",
    "/api/v1/embeddings",
    "/api/v1/moderations",
    "/api/v1/images/generations",
    "/api/v1/messages/count_tokens",
    "/api/v1/responses/input_tokens",
    "batch:/v1/completions",
    "batch:/v1/embeddings",
  ]) {
    assert.equal(needsPiiInstruction(traceFor(endpoint, "restore", email)), false, endpoint);
  }
  assert.equal(needsPiiInstruction(traceFor("/api/v1/chat/completions", "mask", email)), false);
  assert.equal(needsPiiInstruction(traceFor("/api/v1/chat/completions", "restore", [["SECRET", "sk-live-1"]])), false);
  assert.equal(needsPiiInstruction(traceFor("/api/v1/chat/completions", "restore", [])), false);
  assert.equal(needsPiiInstruction(undefined), false);
});

test("the instruction stays compact and names no placeholder that a request could also contain", () => {
  assert.ok(INSTRUCTION.length < 1_200, String(INSTRUCTION.length));
  const vault = new PiiVault();
  vault.placeholder("EMAIL_ADDRESS", EMAIL);
  vault.placeholder("IP_ADDRESS", "203.0.113.9");
  assert.equal(vault.restore(INSTRUCTION), INSTRUCTION);
  assert.equal(/\[[A-Z_]+_\d+\]/.test(INSTRUCTION), false);
});

test("chat completions in restore mode instruct the model, restore the answer, and log the client's request", async () => {
  withPolicy(policy("restore"));
  gateway.reply = () => chatReply(`Sent to ${TOKEN}.`);
  const res = await post("/api/v1/chat/completions", {
    model: MODEL,
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: `Mail ${EMAIL}` },
    ],
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  assert.equal(json.choices[0]?.message.content, `Sent to ${EMAIL}.`);
  assert.deepEqual(upstreamBody().messages, [
    { role: "system", content: `Be brief.\n\n${INSTRUCTION}` },
    { role: "user", content: `Mail ${TOKEN}` },
  ]);
  const [logged] = loggedRequests();
  assert.deepEqual((logged as JsonMap).messages, [
    { role: "system", content: "Be brief." },
    { role: "user", content: `Mail ${TOKEN}` },
  ]);
});

test("mask mode, credential-only redactions, clean prompts, and disabled PII never add the instruction", async () => {
  const cases: [PiiPolicy, string, string][] = [
    [policy("mask"), `Mail ${EMAIL}`, "Mail [EMAIL_ADDRESS]"],
    [policy("restore"), "Use token sk-live-secret-value-123456 now", "[SECRET]"],
    [policy("restore"), "Nothing personal here", "Nothing personal here"],
    [policy("restore", false), `Mail ${EMAIL}`, `Mail ${EMAIL}`],
  ];
  for (const [pii, content, sent] of cases) {
    withPolicy(pii);
    const res = await post("/api/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content }] });
    assert.equal(res.status, 200, content);
    const messages = upstreamBody().messages as JsonMap[];
    assert.equal(messages.length, 1, `${pii.mode} ${content}`);
    assert.equal(String(messages[0]?.content).includes(sent), true, content);
    assert.equal(instructionCount(upstreamBody()), 0, `${pii.mode} ${content}`);
  }
});

test("a client that already sent the instruction and a failover both reach the model with it once", async () => {
  const alias = "pii-failover";
  let calls = 0;
  const failFirst = () => {
    calls = 0;
    gateway.reply = () => (++calls === 1 ? Response.json({ error: { message: "busy" } }, { status: 503 }) : chatReply(TOKEN));
  };
  withPolicy(policy("restore"));
  withGroup(alias, [compatRoute("pii-failover-a"), compatRoute("pii-failover-b")]);
  failFirst();
  const res = await post("/api/v1/chat/completions", {
    model: alias,
    messages: [
      { role: "system", content: `Rules\n\n${INSTRUCTION}` },
      { role: "user", content: `Mail ${EMAIL}` },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(gateway.upstream.length, 2);
  for (let index = 0; index < 2; index++) assert.equal(instructionCount(upstreamBody(index)), 1);

  withPolicy(policy("restore"));
  withGroup(alias, [compatRoute("pii-failover-c"), compatRoute("pii-failover-d")]);
  failFirst();
  await post("/api/v1/chat/completions", { model: alias, messages: [{ role: "user", content: `Mail ${EMAIL}` }] });
  assert.equal(gateway.upstream.length, 2);
  for (let index = 0; index < 2; index++) assert.equal(instructionCount(upstreamBody(index)), 1);
});

test("streamed chat keeps restoring placeholders with the instruction present", async () => {
  withPolicy(policy("restore"));
  gateway.reply = () =>
    sseResponse([
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Sent to [EMAIL_" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ADDRESS_1]" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  const api = await post("/api/v1/chat/completions", {
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: `Mail ${EMAIL}` }],
  });
  const text = await api.text();
  const content = sseEvents(text)
    .map((event) => ((event.choices as JsonMap[] | undefined)?.[0]?.delta as JsonMap | undefined)?.content)
    .filter((piece): piece is string => typeof piece === "string")
    .join("");
  assert.equal(content, `Sent to ${EMAIL}`);
  assert.equal(text.includes("EMAIL_ADDRESS"), false);
  assert.deepEqual((upstreamBody().messages as JsonMap[])[0], { role: "system", content: INSTRUCTION });
  await new Promise((resolve) => setImmediate(resolve));
  const logged = loggedRequests();
  assert.equal(logged.length, 1);
  assert.deepEqual((logged[0] as JsonMap).messages, [{ role: "user", content: `Mail ${TOKEN}` }]);
});

test("Responses add the instruction after the caller's instructions without echoing it", async () => {
  withPolicy(policy("restore"));
  gateway.reply = () => chatReply(`Sent to ${TOKEN}`);
  const res = await post("/api/v1/responses", {
    model: MODEL,
    instructions: "Be brief.",
    input: `Mail ${EMAIL}`,
    store: false,
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as JsonMap;
  assert.equal(json.instructions, "Be brief.");
  assert.match(JSON.stringify(json.output), new RegExp(`Sent to ${EMAIL}`));
  assert.deepEqual((upstreamBody().messages as JsonMap[])[0], { role: "system", content: `Be brief.\n\n${INSTRUCTION}` });

  withPolicy(policy("restore"));
  gateway.reply = () => chatReply("ok");
  await post("/api/v1/responses", { model: MODEL, input: `Mail ${EMAIL}`, store: false });
  assert.deepEqual((upstreamBody().messages as JsonMap[])[0], { role: "system", content: INSTRUCTION });
});

test("streamed Responses restore placeholders split across chat chunks in text and function arguments", async () => {
  withPolicy(policy("restore"));
  const chunk = (delta: JsonMap, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const call = (args: string, start = false) => ({
    tool_calls: [{ index: 0, ...(start ? { id: "call_1", type: "function" } : {}), function: { ...(start ? { name: "send" } : {}), arguments: args } }],
  });
  gateway.reply = () =>
    sseResponse([
      chunk({ content: "Sent to [EMA" }),
      chunk({ content: "IL_ADDRESS" }),
      chunk({ content: "_1]." }),
      chunk(call('{"to":"[EMAIL_', true)),
      chunk(call('ADDRESS_1]"}')),
      chunk({}, "tool_calls"),
      "data: [DONE]\n\n",
    ]);
  const res = await post("/api/v1/responses", { model: MODEL, stream: true, input: `Mail ${EMAIL}`, store: false });
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = sseEvents(text);
  const deltas = (type: string) =>
    events
      .filter((event) => event.type === type)
      .map((event) => String(event.delta))
      .join("");
  assert.equal(deltas("response.output_text.delta"), `Sent to ${EMAIL}.`);
  assert.deepEqual(JSON.parse(deltas("response.function_call_arguments.delta")), { to: EMAIL });
  assert.equal(events.find((event) => event.type === "response.output_text.done")?.text, `Sent to ${EMAIL}.`);
  assert.equal(text.includes("EMAIL_ADDRESS"), false);
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_, index) => index),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loggedRequests().length, 1);
});

test("native Messages keep client cache breakpoints, restore text and tool input, and leave signed thinking alone", async () => {
  withPolicy(policy("restore"));
  const alias = "pii-claude-json";
  withGroup(alias, [anthropicRoute("pii-claude-json-route")]);
  gateway.reply = () =>
    Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        { type: "thinking", thinking: `Write to ${TOKEN}`, signature: "sig-1" },
        { type: "text", text: `Sent to ${TOKEN}` },
        { type: "tool_use", id: "toolu_1", name: "send", input: { to: TOKEN } },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  const res = await post("/api/v1/messages", {
    model: alias,
    max_tokens: 64,
    system: [CACHED_RULES],
    messages: [{ role: "user", content: `Mail ${EMAIL}` }],
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { content: JsonMap[] };
  assert.deepEqual(json.content, [
    { type: "thinking", thinking: `Write to ${TOKEN}`, signature: "sig-1" },
    { type: "text", text: `Sent to ${EMAIL}` },
    { type: "tool_use", id: "toolu_1", name: "send", input: { to: EMAIL } },
  ]);
  assert.match(gateway.upstream[0]?.url ?? "", /\/v1\/messages$/);
  assert.deepEqual(upstreamBody().system, [CACHED_RULES, { type: "text", text: INSTRUCTION }]);
  assert.deepEqual((loggedRequests()[0] as JsonMap).system, [CACHED_RULES]);
});

test("streamed native Messages restore placeholders split across deltas and never edit thinking", async () => {
  withPolicy(policy("restore"));
  const alias = "pii-claude-stream";
  withGroup(alias, [anthropicRoute("pii-claude-stream-route")]);
  const delta = (index: number, value: JsonMap) => anthropicEvent("content_block_delta", { index, delta: value });
  gateway.reply = () =>
    sseResponse([
      anthropicEvent("message_start", {
        message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 1 } },
      }),
      anthropicEvent("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
      delta(0, { type: "thinking_delta", thinking: `Write to ${TOKEN}` }),
      delta(0, { type: "signature_delta", signature: "sig-1" }),
      anthropicEvent("content_block_stop", { index: 0 }),
      anthropicEvent("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      delta(1, { type: "text_delta", text: "Sent to [EMAIL_" }),
      delta(1, { type: "text_delta", text: "ADDRESS_1] and [B" }),
      anthropicEvent("content_block_stop", { index: 1 }),
      anthropicEvent("content_block_start", { index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "send", input: {} } }),
      delta(2, { type: "input_json_delta", partial_json: '{"to": "[EMAIL_ADD' }),
      delta(2, { type: "input_json_delta", partial_json: 'RESS_1]"}' }),
      anthropicEvent("content_block_stop", { index: 2 }),
      anthropicEvent("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
      anthropicEvent("message_stop", {}),
    ]);
  const res = await post("/api/v1/messages", {
    model: alias,
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: `Mail ${EMAIL}` }],
  });
  assert.equal(res.status, 200);
  const events = sseEvents(await res.text());
  const deltas = (index: number, field: string) =>
    events
      .filter((event) => event.type === "content_block_delta" && event.index === index)
      .map((event) => (event.delta as JsonMap)[field])
      .filter((value): value is string => typeof value === "string")
      .join("");
  assert.equal(deltas(0, "thinking"), `Write to ${TOKEN}`);
  assert.equal(deltas(0, "signature"), "sig-1");
  assert.equal(deltas(1, "text"), `Sent to ${EMAIL} and [B`);
  assert.deepEqual(JSON.parse(deltas(2, "partial_json")), { to: EMAIL });
  const order = events.map((event) => `${event.type}:${event.index ?? ""}`);
  assert.ok(order.lastIndexOf("content_block_delta:1") < order.indexOf("content_block_stop:1"));
  assert.equal(order.at(-1), "message_stop:");
  assert.equal(upstreamBody().system, INSTRUCTION);
});

test("Messages on chat deployments carry the instruction in the converted system message", async () => {
  withPolicy(policy("restore"));
  gateway.reply = () => chatReply(`Sent to ${TOKEN}`);
  const res = await post("/api/v1/messages", {
    model: MODEL,
    max_tokens: 64,
    system: "Be brief.",
    messages: [{ role: "user", content: `Mail ${EMAIL}` }],
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { content: JsonMap[] };
  assert.deepEqual(json.content, [{ type: "text", text: `Sent to ${EMAIL}` }]);
  assert.deepEqual((upstreamBody().messages as JsonMap[])[0], { role: "system", content: `Be brief.\n\n${INSTRUCTION}` });
});

test("legacy completions and embeddings stay without the instruction in restore mode", async () => {
  withPolicy(policy("restore"));
  await post("/api/v1/completions", { model: MODEL, prompt: `Mail ${EMAIL}` });
  assert.equal(instructionCount(upstreamBody()), 0);
  assert.equal(
    (upstreamBody().messages as JsonMap[]).some((message) => message.role === "system"),
    false,
  );
  withPolicy(policy("restore"));
  await post("/api/v1/embeddings", { model: MODEL, input: `Mail ${EMAIL}` });
  assert.equal(instructionCount(upstreamBody()), 0);
  assert.equal(upstreamBody().input, `Mail ${TOKEN}`);
});

test("batch lines instruct conversational requests and restore their results", async () => {
  const { runBatchLine } = await import("@/lib/gateway/endpoints/batches");
  withPolicy(policy("restore"));
  gateway.reply = () => chatReply(`Sent to ${TOKEN}`);
  const owner = ownerPrincipal(policy("restore"));
  const line = await runBatchLine(owner, "/v1/chat/completions", {
    model: MODEL,
    messages: [{ role: "user", content: `Mail ${EMAIL}` }],
  });
  assert.equal(line.ok, true);
  assert.match(JSON.stringify(line.ok ? line.body : null), new RegExp(`Sent to ${EMAIL}`));
  assert.deepEqual((upstreamBody().messages as JsonMap[])[0], { role: "system", content: INSTRUCTION });

  withPolicy(policy("restore"));
  gateway.reply = () => chatReply("ok");
  await runBatchLine(owner, "/v1/completions", { model: MODEL, prompt: `Mail ${EMAIL}` });
  assert.equal(instructionCount(upstreamBody()), 0);
});

test("the playground instructs the model in restore mode", async () => {
  const { POST } = await import("@/app/internal-api/playground/chat/route");
  resetGateway();
  setRequest({ cookies: { [SESSION_COOKIE]: await signSessionToken("c".repeat(64)) } });
  recordedPrisma.handlers = {
    session: {
      findUnique: () => ({
        id: "s1",
        expiresAt: new Date(Date.now() + 3_600_000),
        lastActive: new Date(),
        secondFactor: "TOTP",
        ipAddress: null,
        userAgent: null,
        user: {
          id: "member-1",
          username: "member",
          blocked: false,
          isOwner: false,
          orgId: "o1",
          roleId: "r1",
          role: { id: "r1", templateKey: null, name: "Member", permissions: ["playground:use"] },
        },
      }),
    },
    organization: {
      findUnique: () => ({
        id: "o1",
        spend: 0,
        maxBudget: 0,
        budgetDuration: "",
        spendResetAt: null,
        createdAt: new Date(0),
      }),
    },
  };
  setOverride({ orgId: "o1" }, { pii: policy("restore") });
  gateway.reply = () =>
    sseResponse([
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `Hi ${TOKEN}` } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  const res = await POST(
    new Request("http://hub.local/internal-api/playground/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: `Mail ${EMAIL}` }] }),
    }),
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), new RegExp(`Hi ${EMAIL}`));
  assert.deepEqual((upstreamBody().messages as JsonMap[])[0], { role: "system", content: INSTRUCTION });
});
