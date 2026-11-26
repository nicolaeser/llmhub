import "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { GateError } from "@/lib/gateway/errors";
import {
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  McpClient,
} from "@/lib/mcp/client";
import {
  answerMcp,
  GATEWAY_REFUSED,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  MCP_TOOLS_TTL_MS,
  McpEndpointError,
  PARSE_ERROR,
  serveMcpPost,
  type McpEndpointTools,
} from "@/lib/mcp/endpoint";
import { MCP_SSE_MESSAGES_PATH, openMcpSseStream, postMcpSseMessage } from "@/lib/mcp/endpoint-sse";
import { headerValue } from "@/lib/mcp/headers";
import type { JsonMap } from "@/types/gateway";
import type { McpConnection, McpFetch } from "@/types/mcp";

const META = {
  "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
};

const tools: McpEndpointTools = {
  info: { name: "lab", version: "1.0.0" },
  async list() {
    return [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }];
  },
  async call(name, args) {
    if (name === "echo") return { content: [{ type: "text", text: `echo ${String(args.text)}` }], isError: false };
    if (name === "gate") throw new GateError(429, "budget_exceeded", "budget exceeded");
    if (name === "crash") throw new Error("database is down");
    throw new McpEndpointError(INVALID_PARAMS, `Unknown tool: ${name}`);
  },
};

const signal = () => AbortSignal.timeout(5_000);

function modernHeaders(method: string, extra: Record<string, string> = {}): Headers {
  return new Headers({ "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, "Mcp-Method": method, ...extra });
}

function modern(method: string, params: JsonMap = {}, id: unknown = 1): JsonMap {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: META } };
}

function errorOf(body: unknown): JsonMap {
  return (body as JsonMap).error as JsonMap;
}

function resultOf(body: unknown): JsonMap {
  return (body as JsonMap).result as JsonMap;
}

test("server/discover advertises every supported version with cache hints and server info", async () => {
  const reply = await answerMcp(modern("server/discover"), modernHeaders("server/discover"), tools, signal());
  assert.equal(reply.status, 200);
  const result = resultOf(reply.body);
  assert.equal(result.resultType, "complete");
  assert.deepEqual(result.supportedVersions, MCP_SUPPORTED_PROTOCOL_VERSIONS);
  assert.equal(result.cacheScope, "public");
  assert.equal(typeof result.ttlMs, "number");
  assert.deepEqual((result._meta as JsonMap)["io.modelcontextprotocol/serverInfo"], tools.info);
});

test("modern requests are validated against their mirrored headers", async () => {
  const listed = await answerMcp(modern("tools/list"), modernHeaders("tools/list"), tools, signal());
  assert.equal(resultOf(listed.body).ttlMs, MCP_TOOLS_TTL_MS);
  assert.equal(resultOf(listed.body).cacheScope, "private");

  const noMethod = await answerMcp(modern("tools/list"), new Headers({ "MCP-Protocol-Version": MCP_PROTOCOL_VERSION }), tools, signal());
  assert.equal(noMethod.status, 400);
  assert.equal(errorOf(noMethod.body).code, -32020);

  const call = modern("tools/call", { name: "echo", arguments: { text: "hi" } });
  const missingName = await answerMcp(call, modernHeaders("tools/call"), tools, signal());
  assert.equal(errorOf(missingName.body).code, -32020);
  const wrongName = await answerMcp(call, modernHeaders("tools/call", { "Mcp-Name": "other" }), tools, signal());
  assert.equal(errorOf(wrongName.body).code, -32020);

  const sentinel = await answerMcp(call, modernHeaders("tools/call", { "Mcp-Name": headerValue("=?base64?echo?=") }), tools, signal());
  assert.equal(errorOf(sentinel.body).code, -32020);
  const encoded = await answerMcp(call, modernHeaders("tools/call", { "Mcp-Name": `=?base64?${Buffer.from("echo").toString("base64")}?=` }), tools, signal());
  assert.equal(encoded.status, 200);
  const plain = await answerMcp(call, modernHeaders("tools/call", { "Mcp-Name": "echo" }), tools, signal());
  assert.equal(plain.status, 200);
  assert.deepEqual(resultOf(plain.body).content, [{ type: "text", text: "echo hi" }]);
});

test("modern errors use the spec's codes and statuses", async () => {
  const body = { jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } };
  const future = await answerMcp(body, new Headers({ "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" }), tools, signal());
  assert.equal(future.status, 400);
  assert.deepEqual(errorOf(future.body).data, { supported: MCP_SUPPORTED_PROTOCOL_VERSIONS, requested: "2099-01-01" });

  const bare = { jsonrpc: "2.0", id: 5, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION } } };
  const noCapabilities = await answerMcp(bare, modernHeaders("tools/list"), tools, signal());
  assert.equal(noCapabilities.status, 400);
  assert.equal(errorOf(noCapabilities.body).code, INVALID_PARAMS);

  const unknown = await answerMcp(modern("ping"), modernHeaders("ping"), tools, signal());
  assert.equal(unknown.status, 404);
  assert.equal(errorOf(unknown.body).code, -32601);

  const note = await answerMcp({ jsonrpc: "2.0", method: "notifications/x", params: { _meta: META } }, new Headers(), tools, signal());
  assert.deepEqual(note, { status: 202, body: null });
});

test("tool failures become JSON-RPC errors without leaking internals", async () => {
  const headers = (name: string) => modernHeaders("tools/call", { "Mcp-Name": name });
  const gate = await answerMcp(modern("tools/call", { name: "gate" }), headers("gate"), tools, signal());
  assert.deepEqual(errorOf(gate.body), { code: GATEWAY_REFUSED, message: "budget exceeded", data: { status: 429, code: "budget_exceeded" } });
  const crash = await answerMcp(modern("tools/call", { name: "crash" }), headers("crash"), tools, signal());
  assert.deepEqual(errorOf(crash.body), { code: INTERNAL_ERROR, message: "Internal error" });
});

test("legacy requests negotiate a version and reject headers they cannot honor", async () => {
  for (const version of MCP_LEGACY_PROTOCOL_VERSIONS) {
    const init = await answerMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } }, new Headers(), tools, signal());
    assert.equal(resultOf(init.body).protocolVersion, version);
    assert.deepEqual(resultOf(init.body).capabilities, { tools: { listChanged: false } });
  }
  const unversioned = await answerMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, new Headers(), tools, signal());
  assert.equal(unversioned.status, 200);
  assert.equal((resultOf(unversioned.body).tools as JsonMap[]).length, 1);

  const modernHeader = await answerMcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, modernHeaders("tools/list"), tools, signal());
  assert.equal(modernHeader.status, 400);
  assert.equal(errorOf(modernHeader.body).code, -32020);

  const ancient = await answerMcp({ jsonrpc: "2.0", id: 4, method: "tools/list" }, new Headers({ "MCP-Protocol-Version": "2023-01-01" }), tools, signal());
  assert.equal(ancient.status, 400);
  assert.equal(errorOf(ancient.body).code, -32022);

  const reply = await answerMcp({ jsonrpc: "2.0", id: 7, result: {} }, new Headers(), tools, signal());
  assert.deepEqual(reply, { status: 202, body: null });
  const invalid = await answerMcp({ id: 8, method: "tools/list" }, new Headers(), tools, signal());
  assert.equal(invalid.status, 400);
  assert.equal(errorOf(invalid.body).code, INVALID_REQUEST);
});

test("2025-03-26 batches answer every request and skip notifications", async () => {
  const batch = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "batch" } } },
  ];
  const reply = await answerMcp(batch, new Headers(), tools, signal());
  assert.equal(reply.status, 200);
  assert.deepEqual((reply.body as JsonMap[]).map((item) => item.id), [1, 2]);
  const empty = await answerMcp([], new Headers(), tools, signal());
  assert.equal(errorOf((empty.body as JsonMap[])[0]).code, INVALID_REQUEST);
  const onlyNotes = await answerMcp([{ jsonrpc: "2.0", method: "notifications/initialized" }], new Headers(), tools, signal());
  assert.deepEqual(onlyNotes, { status: 202, body: null });
});

test("invalid JSON answers a parse error", async () => {
  const res = await serveMcpPost(new Request("http://hub.test/api/v1/mcp", { method: "POST", body: "{nope" }), tools);
  assert.equal(res.status, 400);
  assert.equal(errorOf(await res.json()).code, PARSE_ERROR);
});

function endpointFetch(): McpFetch {
  return async (url, init) =>
    serveMcpPost(new Request(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal }), tools);
}

async function roundTrip(connection: McpConnection | null): Promise<{ name: string; text: string; connection: McpConnection | null }> {
  const client = new McpClient({ url: "http://hub.test/api/v1/mcp", fetch: endpointFetch(), connection });
  const name = await client.discover();
  const listed = await client.listTools();
  assert.deepEqual(listed.map((tool) => tool.name), ["echo"]);
  const outcome = await client.callTool("echo", { text: "round trip" });
  await client.close();
  return { name, text: outcome.text, connection: client.connection };
}

test("the hub's own MCP client works against the endpoint in the modern and legacy eras", async () => {
  const fresh = await roundTrip(null);
  assert.deepEqual(fresh, {
    name: "lab",
    text: "echo round trip",
    connection: { transport: "streamable_http", protocolVersion: MCP_PROTOCOL_VERSION },
  });
  const legacy = await roundTrip({ transport: "streamable_http", protocolVersion: "2025-06-18" });
  assert.deepEqual(legacy.connection, { transport: "streamable_http", protocolVersion: MCP_LEGACY_PROTOCOL_VERSIONS[0] });
  assert.equal(legacy.text, "echo round trip");
});

function sseFetch(owner: string): McpFetch {
  return async (url, init) => {
    const req = new Request(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
    const path = new URL(url).pathname;
    if (init.method === "GET" && path === "/api/v1/mcp/sse") return openMcpSseStream(owner, init.signal ?? signal());
    if (init.method === "POST" && path === MCP_SSE_MESSAGES_PATH) return postMcpSseMessage(req, owner, tools);
    return new Response(null, { status: 404 });
  };
}

test("the deprecated HTTP+SSE transport serves 2024-11-05 clients", async () => {
  const client = new McpClient({ url: "http://hub.test/api/v1/mcp/sse", fetch: sseFetch("key:a"), connection: { transport: "sse", protocolVersion: "2024-11-05" } });
  assert.equal(await client.discover(), "lab");
  assert.equal((await client.callTool("echo", { text: "sse" })).text, "echo sse");
  assert.deepEqual(client.connection, { transport: "sse", protocolVersion: MCP_LEGACY_PROTOCOL_VERSIONS[0] });
  await client.close();
});

test("HTTP+SSE messages only reach the stream of the same caller", async () => {
  const abort = new AbortController();
  const res = openMcpSseStream("key:owner", abort.signal);
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const endpoint = /data: (\S+)/.exec(first)![1]!;
  assert.match(endpoint, new RegExp(`^${MCP_SSE_MESSAGES_PATH}\\?sessionId=`));
  const post = (owner: string) =>
    postMcpSseMessage(
      new Request(`http://hub.test${endpoint}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }),
      owner,
      tools,
    );
  assert.equal((await post("key:intruder")).status, 404);
  assert.equal((await post("key:owner")).status, 202);
  const delivered = new TextDecoder().decode((await reader.read()).value);
  assert.match(delivered, /^event: message\ndata: \{"jsonrpc":"2.0","id":1,"result":\{\}\}/);
  abort.abort();
  assert.equal((await post("key:owner")).status, 404);
});
