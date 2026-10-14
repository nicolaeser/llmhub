import { chatReply, gateway, gatewayRequest, MODEL, resetGateway, type UpstreamCall } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { seal } from "@/lib/crypto";
import type { JsonMap } from "@/types/gateway";

const TOOL = "mcp__weather__forecast";
const mcpCalls: { method: string; auth: string; session: string; version: string; name: string; params: JsonMap }[] = [];
let toolText = (city: string) => `Sunny in ${city}`;
let stateless = false;
let port = 0;

const server = createServer(async (req: IncomingMessage, res) => {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  if (req.method === "DELETE") {
    res.writeHead(204).end();
    return;
  }
  const body = JSON.parse(raw) as JsonMap;
  mcpCalls.push({
    method: String(body.method),
    auth: String(req.headers.authorization ?? ""),
    session: String(req.headers["mcp-session-id"] ?? ""),
    version: String(req.headers["mcp-protocol-version"] ?? ""),
    name: String(req.headers["mcp-name"] ?? ""),
    params: (body.params as JsonMap) ?? {},
  });
  if (!stateless && body.method !== "initialize" && !req.headers["mcp-session-id"]) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: No valid session ID provided" } }));
    return;
  }
  if (body.method === "initialize") {
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "w" } } }));
    return;
  }
  if (body.method === "notifications/initialized") {
    res.writeHead(202).end();
    return;
  }
  const args = ((body.params as JsonMap).arguments as JsonMap) ?? {};
  const event = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: toolText(String(args.city)) }] } };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
});

function serverRow() {
  return {
    id: "srv1",
    name: "weather",
    url: `http://127.0.0.1:${port}/mcp`,
    authType: "bearer",
    authHeader: "",
    authSecret: seal("mcp-secret"),
    oauthGrant: "authorization_code",
    oauthClientId: "",
    oauthScopes: "",
    transport: "streamable_http",
    protocolVersion: stateless ? "2026-07-28" : "",
    internal: true,
    enabled: true,
    global: false,
    toolsRestricted: false,
    allowedTools: [],
    tools: [
      { name: "forecast", description: "Weather forecast", inputSchema: { type: "object", properties: { city: { type: "string" } } } },
    ],
    assignments: [{ serverId: "srv1", orgId: null, teamId: null, projectId: null, memberId: null, keyId: "key-1", mode: "allow", blockedTools: [] }],
  };
}

function reset(): JsonMap[] {
  resetGateway();
  mcpCalls.length = 0;
  stateless = false;
  toolText = (city) => `Sunny in ${city}`;
  recordedPrisma.handlers = { mcpServer: { findMany: () => [serverRow()] } };
  const bodies: JsonMap[] = [];
  return bodies;
}

function toolCallReply(calls: { id: string; name: string; arguments: string }[]): Response {
  return Response.json({
    id: "chatcmpl-tool",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

function scripted(bodies: JsonMap[], replies: ((call: UpstreamCall) => Response)[]) {
  gateway.reply = (call) => {
    bodies.push(call.body ?? {});
    const next = replies[bodies.length - 1] ?? (() => chatReply("done"));
    return next(call);
  };
}

const forecast = { id: "call_1", name: TOOL, arguments: '{"city":"Bern"}' };

async function post(path: string, body: JsonMap, headers: Record<string, string> = {}): Promise<Response> {
  const mod =
    path === "/api/v1/chat/completions"
      ? await import("@/app/api/v1/chat/completions/route")
      : path === "/api/v1/messages"
        ? await import("@/app/api/v1/messages/route")
        : await import("@/app/api/v1/responses/route");
  return mod.POST(gatewayRequest(path, body, headers));
}

const question = { model: MODEL, messages: [{ role: "user", content: "Weather in Bern?" }] };

test("chat completions run MCP tool calls inside the gateway and return the final answer", async () => {
  const bodies = reset();
  scripted(bodies, [() => toolCallReply([forecast]), () => chatReply("It is sunny in Bern.")]);
  const res = await post("/api/v1/chat/completions", question);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Hub-Cache"), "BYPASS");
  const json = (await res.json()) as JsonMap;
  const choice = (json.choices as JsonMap[])[0]!;
  assert.equal((choice.message as JsonMap).content, "It is sunny in Bern.");
  assert.deepEqual(json.usage, {
    prompt_tokens: 6,
    completion_tokens: 4,
    total_tokens: 10,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  assert.equal(bodies.length, 2);
  const tools = bodies[0]!.tools as JsonMap[];
  assert.equal((tools[0]!.function as JsonMap).name, TOOL);
  assert.deepEqual((tools[0]!.function as JsonMap).parameters, { type: "object", properties: { city: { type: "string" } } });
  const second = bodies[1]!.messages as JsonMap[];
  assert.deepEqual(second.at(-1), { role: "tool", tool_call_id: "call_1", content: "Sunny in Bern" });
  assert.equal(((second.at(-2)!.tool_calls as JsonMap[])[0]!.function as JsonMap).name, TOOL);
  const call = mcpCalls.filter((item) => item.method === "tools/call").at(-1)!;
  assert.deepEqual(call.params, { name: "forecast", arguments: { city: "Bern" } });
  assert.equal(call.auth, "Bearer mcp-secret");
  assert.equal(call.session, "sess-1");
  assert.deepEqual(
    mcpCalls.map((item) => item.method),
    ["tools/call", "initialize", "notifications/initialized", "tools/call"],
  );
  const remembered = recordedPrisma.called("mcpServer", "updateMany").map((item) => item.args);
  assert.deepEqual(remembered, [{ where: { id: "srv1" }, data: { transport: "streamable_http", protocolVersion: "2025-06-18" } }]);
  const logged = recordedPrisma.called("requestLog", "create").length + recordedPrisma.called("usageDaily", "upsert").length;
  assert.ok(logged >= 2);
  assert.ok(!JSON.stringify(json).includes("mcp-secret"));
});

test("a stateless MCP server gets one request per tool call without a handshake", async () => {
  const bodies = reset();
  stateless = true;
  recordedPrisma.handlers = { mcpServer: { findMany: () => [serverRow()] } };
  scripted(bodies, [() => toolCallReply([forecast]), () => chatReply("It is sunny in Bern.")]);
  const res = await post("/api/v1/chat/completions", question);
  assert.equal(res.status, 200);
  assert.deepEqual(mcpCalls.map((item) => item.method), ["tools/call"]);
  const call = mcpCalls[0]!;
  assert.equal(call.session, "");
  assert.equal(call.version, "2026-07-28");
  assert.equal(call.name, "forecast");
  assert.equal(((call.params._meta as JsonMap)["io.modelcontextprotocol/protocolVersion"]), "2026-07-28");
  assert.equal(recordedPrisma.called("mcpServer", "updateMany").length, 0);
});

test("the opt-out header and keys without assignments leave the request untouched", async () => {
  const bodies = reset();
  scripted(bodies, [() => chatReply("plain")]);
  await post("/api/v1/chat/completions", question, { "X-LLMHub-MCP": "off" });
  assert.equal(bodies[0]!.tools, undefined);

  const others = reset();
  recordedPrisma.handlers = { mcpServer: { findMany: () => [{ ...serverRow(), assignments: [] }] } };
  scripted(others, [() => chatReply("plain")]);
  await post("/api/v1/chat/completions", question);
  assert.equal(others[0]!.tools, undefined);
  assert.equal(mcpCalls.length, 0);
});

test("mixed tool calls go back to the caller without running MCP tools", async () => {
  const bodies = reset();
  scripted(bodies, [() => toolCallReply([forecast, { id: "call_2", name: "lookup", arguments: "{}" }])]);
  const res = await post("/api/v1/chat/completions", {
    ...question,
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  });
  const json = (await res.json()) as JsonMap;
  const choice = (json.choices as JsonMap[])[0]!;
  const calls = (choice.message as JsonMap).tool_calls as JsonMap[];
  assert.deepEqual(calls.map((call) => (call.function as JsonMap).name), ["lookup"]);
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(bodies.length, 1);
  assert.equal(mcpCalls.length, 0);
  assert.deepEqual(((bodies[0]!.tools as JsonMap[]).map((tool) => (tool.function as JsonMap).name)), ["lookup", TOOL]);
});

function sseReply(chunks: JsonMap[]): Response {
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: JsonMap, finish: string | null = null, usage?: JsonMap): JsonMap {
  return { id: "chunk", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) };
}

test("streaming chat runs MCP rounds server-side and streams one continuous answer", async () => {
  const bodies = reset();
  scripted(bodies, [
    () =>
      sseReply([
        chunk({ role: "assistant", content: "Checking. " }),
        chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: TOOL, arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":"Bern"}' } }] }),
        chunk({}, "tool_calls"),
        { id: "chunk", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
      ]),
    () =>
      sseReply([
        chunk({ role: "assistant", content: "Sunny." }),
        chunk({}, "stop"),
        { id: "chunk", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } },
      ]),
  ]);
  const res = await post("/api/v1/chat/completions", { ...question, stream: true, stream_options: { include_usage: true } });
  assert.equal(res.headers.get("content-type")?.startsWith("text/event-stream"), true);
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  assert.equal(events.at(-1), "[DONE]");
  const parsed = events.slice(0, -1).map((data) => JSON.parse(data) as JsonMap);
  const content = parsed
    .flatMap((item) => (item.choices as JsonMap[]) ?? [])
    .map((choice) => String((choice.delta as JsonMap)?.content ?? ""))
    .join("");
  assert.equal(content, "Checking. Sunny.");
  assert.ok(!text.includes(TOOL));
  const finishes = parsed.flatMap((item) => (item.choices as JsonMap[]).map((choice) => choice.finish_reason)).filter(Boolean);
  assert.deepEqual(finishes, ["stop"]);
  assert.deepEqual(parsed.at(-1)!.usage, {
    prompt_tokens: 7,
    completion_tokens: 3,
    total_tokens: 10,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual((bodies[1]!.messages as JsonMap[]).at(-1), { role: "tool", tool_call_id: "call_1", content: "Sunny in Bern" });
});

test("anthropic messages run the loop and hide MCP tool_use blocks", async () => {
  const bodies = reset();
  scripted(bodies, [() => toolCallReply([forecast]), () => chatReply("Sunny in Bern.")]);
  const res = await post("/api/v1/messages", { model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "Weather in Bern?" }] });
  assert.equal(res.status, 200);
  const json = (await res.json()) as JsonMap;
  assert.deepEqual(json.content, [{ type: "text", text: "Sunny in Bern." }]);
  assert.equal(json.stop_reason, "end_turn");
  assert.equal((json.usage as JsonMap).input_tokens, 6);
  const second = bodies[1]!.messages as JsonMap[];
  assert.deepEqual(second.at(-1), { role: "tool", tool_call_id: "call_1", content: "Sunny in Bern" });
});

test("streaming messages hide MCP tool_use blocks and renumber content blocks across steps", async () => {
  const bodies = reset();
  scripted(bodies, [
    () =>
      sseReply([
        chunk({ role: "assistant", content: "Checking. " }),
        chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: TOOL, arguments: '{"city":"Bern"}' } }] }),
        chunk({}, "tool_calls", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
      ]),
    () => sseReply([chunk({ role: "assistant", content: "Sunny." }), chunk({}, "stop", { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 })]),
  ]);
  const res = await post("/api/v1/messages", {
    model: MODEL,
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "Weather in Bern?" }],
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as JsonMap);
  const types = events.map((event) => event.type);
  assert.equal(types.filter((type) => type === "message_start").length, 1);
  assert.equal(types.filter((type) => type === "message_stop").length, 1);
  assert.equal(types.at(-1), "message_stop");
  assert.ok(!text.includes(TOOL));
  const starts = events.filter((event) => event.type === "content_block_start").map((event) => event.index);
  assert.deepEqual(starts, [0, 1]);
  const said = events
    .filter((event) => event.type === "content_block_delta")
    .map((event) => String((event.delta as JsonMap).text ?? ""))
    .join("");
  assert.equal(said, "Checking. Sunny.");
  const delta = events.find((event) => event.type === "message_delta")!;
  assert.equal((delta.delta as JsonMap).stop_reason, "end_turn");
  assert.equal((delta.usage as JsonMap).output_tokens, 3);
  assert.equal(bodies.length, 2);
});

test("responses list mcp_call items before the answer", async () => {
  const bodies = reset();
  scripted(bodies, [() => toolCallReply([forecast]), () => chatReply("Sunny in Bern.")]);
  const res = await post("/api/v1/responses", { model: MODEL, input: "Weather in Bern?", store: false });
  assert.equal(res.status, 200);
  const json = (await res.json()) as JsonMap;
  const output = json.output as JsonMap[];
  assert.deepEqual(
    output.map((item) => item.type),
    ["mcp_call", "message"],
  );
  assert.equal(output[0]!.server_label, "weather");
  assert.equal(output[0]!.name, "forecast");
  assert.equal(output[0]!.output, "Sunny in Bern");
  assert.equal(json.output_text, "Sunny in Bern.");
});

test("tool results pass the PII policy before reaching the model", async () => {
  const bodies = reset();
  gateway.enterprise = { pii: { enabled: true, mode: "mask", output: false, entities: ["EMAIL_ADDRESS"] } };
  toolText = () => "Contact ada@acme.com";
  scripted(bodies, [() => toolCallReply([forecast]), () => chatReply("ok")]);
  await post("/api/v1/chat/completions", question);
  assert.deepEqual((bodies[1]!.messages as JsonMap[]).at(-1), {
    role: "tool",
    tool_call_id: "call_1",
    content: "Contact [EMAIL_ADDRESS]",
  });

  const blocked = reset();
  gateway.enterprise = { pii: { enabled: true, mode: "block", output: false, entities: ["EMAIL_ADDRESS"] } };
  toolText = () => "Contact ada@acme.com";
  scripted(blocked, [() => toolCallReply([forecast]), () => chatReply("never")]);
  const res = await post("/api/v1/chat/completions", question);
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: JsonMap }).error.code, "pii_blocked");
  assert.equal(blocked.length, 1);
});

test("the loop stops offering MCP tools at the step limit", async () => {
  const bodies = reset();
  scripted(bodies, Array.from({ length: 10 }, () => () => toolCallReply([forecast])));
  const res = await post("/api/v1/chat/completions", question);
  const json = (await res.json()) as JsonMap;
  assert.equal(bodies.length, 8);
  assert.equal(bodies[7]!.tools, undefined);
  const choice = (json.choices as JsonMap[])[0]!;
  assert.equal((choice.message as JsonMap).tool_calls, undefined);
  assert.equal(choice.finish_reason, "stop");
});
