import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_MAX_TOOL_RESULT_CHARS,
  MCP_PROTOCOL_VERSION,
  McpClient,
  annotationHint,
  staticAuth,
  toolOutcome,
  toolSpecs,
} from "@/lib/mcp/client";
import { McpError } from "@/lib/mcp/errors";
import { bearerChallenge, headerParams, headerValue, paramHeaders } from "@/lib/mcp/headers";
import { sseEvents } from "@/lib/mcp/sse";
import type { JsonMap } from "@/types/gateway";
import type { McpAuth, McpFetch } from "@/types/mcp";

type Seen = { url: string; method: string; headers: Record<string, string>; body: JsonMap | null };

const META_VERSION = "io.modelcontextprotocol/protocolVersion";

function sse(events: unknown[], ids = false): Response {
  const text = events
    .map((event, index) => `${ids ? `id: ${index}\r\n` : ""}event: message\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function rpcError(id: unknown, code: number, message: string, status = 400, data?: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }, { status });
}

function parse(init: { body?: string }): JsonMap | null {
  return init.body ? (JSON.parse(init.body) as JsonMap) : null;
}

function toolsPage(body: JsonMap): JsonMap {
  const cursor = (body.params as JsonMap).cursor;
  return cursor
    ? { tools: [{ name: "forecast", description: "Forecast", inputSchema: { type: "object", properties: { city: { type: "string" } } } }] }
    : { tools: [{ name: "now", inputSchema: { type: "object" } }, { name: "", inputSchema: {} }], nextCursor: "page-2" };
}

function modernServer(options: { sse?: boolean; result?: (body: JsonMap) => JsonMap } = {}) {
  const seen: Seen[] = [];
  const fetch: McpFetch = async (url, init) => {
    const body = parse(init);
    seen.push({ url, method: init.method, headers: init.headers, body });
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const meta = ((body?.params as JsonMap | undefined)?._meta as JsonMap | undefined) ?? {};
    if (init.headers["MCP-Protocol-Version"] !== MCP_PROTOCOL_VERSION || meta[META_VERSION] !== MCP_PROTOCOL_VERSION) {
      return rpcError(body?.id, -32022, "Unsupported protocol version", 400, { supported: [MCP_PROTOCOL_VERSION] });
    }
    if (init.headers["Mcp-Method"] !== body?.method) return rpcError(body?.id, -32020, "Header mismatch");
    const rpc = body!.method;
    let result: JsonMap;
    if (options.result) result = options.result(body!);
    else if (rpc === "server/discover") {
      result = { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "Weather" } } };
    } else if (rpc === "tools/list") result = toolsPage(body!);
    else if (rpc === "tools/call") {
      const args = (body!.params as JsonMap).arguments as JsonMap;
      result = { content: [{ type: "text", text: `Sunny in ${String(args.city)}` }] };
    } else return rpcError(body!.id, -32601, "Method not found", 404);
    const reply = { jsonrpc: "2.0", id: body!.id, result: { resultType: "complete", ...result } };
    if (options.sse) return sse([{ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }, reply]);
    return Response.json(reply);
  };
  return { fetch, seen };
}

function legacyServer(options: { sse?: boolean; expireOnce?: boolean; session?: string; version?: string } = {}) {
  const seen: Seen[] = [];
  let expired = false;
  let sessions = 0;
  const fetch: McpFetch = async (url, init) => {
    const body = parse(init);
    seen.push({ url, method: init.method, headers: init.headers, body });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const rpc = body?.method;
    if (rpc === "initialize") {
      sessions += 1;
      const version = options.version ?? "2025-06-18";
      return Response.json(
        { jsonrpc: "2.0", id: body!.id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "Weather" } } },
        { headers: { "Mcp-Session-Id": `${options.session ?? "s"}-${sessions}` } },
      );
    }
    if (!init.headers["Mcp-Session-Id"]) return rpcError(null, -32000, "Bad Request: No valid session ID provided");
    if (rpc === "notifications/initialized") return new Response(null, { status: 202 });
    if (options.expireOnce && !expired && rpc === "tools/list") {
      expired = true;
      return new Response("gone", { status: 404 });
    }
    if (rpc === "tools/list") return Response.json({ jsonrpc: "2.0", id: body!.id, result: toolsPage(body!) });
    if (rpc === "tools/call") {
      const args = (body!.params as JsonMap).arguments as JsonMap;
      const reply = { jsonrpc: "2.0", id: body!.id, result: { content: [{ type: "text", text: `Sunny in ${String(args.city)}` }] } };
      if (options.sse) return sse([{ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }, reply]);
      return Response.json(reply);
    }
    return Response.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "no such method" } });
  };
  return { fetch, seen };
}

test("a stateless server gets per-request metadata, no handshake, and no session", async () => {
  const server = modernServer();
  const client = new McpClient({ url: "https://mcp.test/mcp", auth: staticAuth({ Authorization: "Bearer t" }), fetch: server.fetch });
  assert.equal(await client.discover(), "Weather");
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["now", "forecast"],
  );
  const outcome = await client.callTool("forecast", { city: "Bern" });
  assert.deepEqual(outcome, { text: "Sunny in Bern", isError: false });
  assert.deepEqual(
    server.seen.map((call) => call.body?.method),
    ["server/discover", "tools/list", "tools/list", "tools/call"],
  );
  for (const call of server.seen) {
    assert.equal(call.headers.Authorization, "Bearer t");
    assert.equal(call.headers.Accept, "application/json, text/event-stream");
    assert.equal(call.headers["Mcp-Session-Id"], undefined);
    const meta = (call.body!.params as JsonMap)._meta as JsonMap;
    assert.deepEqual(meta["io.modelcontextprotocol/clientInfo"], { name: "llmhub", version: "1.0.0" });
    assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"], {});
  }
  const call = server.seen.at(-1)!;
  assert.equal(call.headers["Mcp-Name"], "forecast");
  assert.deepEqual(client.connection, { transport: "streamable_http", protocolVersion: MCP_PROTOCOL_VERSION });
  assert.equal(await client.close(), false);
  assert.equal(server.seen.length, 4);
});

test("a stateless server can answer over a request-scoped event stream", async () => {
  const server = modernServer({ sse: true });
  const client = new McpClient({ url: "https://mcp.test/mcp", fetch: server.fetch });
  assert.deepEqual(await client.callTool("forecast", { city: "Bern" }), { text: "Sunny in Bern", isError: false });
});

test("a server that answers without a session falls back to initialize and keeps the session", async () => {
  const server = legacyServer();
  const client = new McpClient({ url: "https://mcp.test/mcp", auth: staticAuth({ Authorization: "Bearer t" }), fetch: server.fetch });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["now", "forecast"],
  );
  const methods = server.seen.map((call) => call.body?.method);
  assert.deepEqual(methods, ["tools/list", "initialize", "notifications/initialized", "tools/list", "tools/list"]);
  const init = server.seen[1]!;
  assert.equal(init.headers["Mcp-Session-Id"], undefined);
  assert.deepEqual(init.body!.params, {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "llmhub", version: "1.0.0" },
  });
  for (const later of server.seen.slice(2)) {
    assert.equal(later.headers["Mcp-Session-Id"], "s-1");
    assert.equal(later.headers["MCP-Protocol-Version"], "2025-06-18");
    assert.equal(later.headers.Authorization, "Bearer t");
  }
  assert.deepEqual(server.seen[4]!.body!.params, { cursor: "page-2" });
  assert.equal(server.seen[2]!.body!.id, undefined);
  assert.deepEqual(client.connection, { transport: "streamable_http", protocolVersion: "2025-06-18" });

  assert.equal(await client.close(), true);
  const last = server.seen.at(-1)!;
  assert.equal(last.method, "DELETE");
  assert.equal(last.headers["Mcp-Session-Id"], "s-1");
});

test("a stored legacy version skips the stateless probe", async () => {
  const server = legacyServer({ sse: true });
  const client = new McpClient({
    url: "https://mcp.test/mcp",
    fetch: server.fetch,
    connection: { transport: "streamable_http", protocolVersion: "2025-06-18" },
  });
  assert.deepEqual(await client.callTool("forecast", { city: "Bern" }), { text: "Sunny in Bern", isError: false });
  assert.deepEqual(
    server.seen.map((call) => call.body?.method),
    ["initialize", "notifications/initialized", "tools/call"],
  );
  assert.deepEqual(server.seen.at(-1)!.body!.params, { name: "forecast", arguments: { city: "Bern" } });
});

test("an expired session (404) re-initializes once and retries", async () => {
  const server = legacyServer({ expireOnce: true });
  const client = new McpClient({
    url: "https://mcp.test/mcp",
    fetch: server.fetch,
    connection: { transport: "streamable_http", protocolVersion: "2025-06-18" },
  });
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
  const inits = server.seen.filter((item) => item.body?.method === "initialize");
  assert.equal(inits.length, 2);
  const lists = server.seen.filter((item) => item.body?.method === "tools/list");
  assert.equal(lists.at(-1)!.headers["Mcp-Session-Id"], "s-2");
});

test("an unsupported version error picks a legacy version the server lists", async () => {
  const legacy = legacyServer({ version: "2025-03-26" });
  const fetch: McpFetch = async (url, init) => {
    const body = parse(init);
    if (init.headers["MCP-Protocol-Version"] === MCP_PROTOCOL_VERSION) {
      return rpcError(body?.id, -32022, "Unsupported protocol version", 400, {
        supported: ["2025-03-26"],
        requested: MCP_PROTOCOL_VERSION,
      });
    }
    return legacy.fetch(url, init);
  };
  const client = new McpClient({ url: "https://mcp.test/mcp", fetch });
  assert.equal(await client.discover(), "Weather");
  const init = legacy.seen.find((call) => call.body?.method === "initialize")!;
  assert.equal((init.body!.params as JsonMap).protocolVersion, "2025-03-26");
  assert.deepEqual(client.connection, { transport: "streamable_http", protocolVersion: "2025-03-26" });
});

test("a stored legacy version moves to stateless when the server rejects initialize with a modern error", async () => {
  const modern = modernServer();
  const fetch: McpFetch = async (url, init) => {
    const body = parse(init);
    if (body?.method === "initialize") {
      return rpcError(body.id, -32022, "Unsupported protocol version", 400, { supported: [MCP_PROTOCOL_VERSION] });
    }
    return modern.fetch(url, init);
  };
  const client = new McpClient({
    url: "https://mcp.test/mcp",
    fetch,
    connection: { transport: "streamable_http", protocolVersion: "2025-06-18" },
  });
  assert.deepEqual(await client.callTool("forecast", { city: "Basel" }), { text: "Sunny in Basel", isError: false });
  assert.deepEqual(client.connection, { transport: "streamable_http", protocolVersion: MCP_PROTOCOL_VERSION });
});

test("a server that rejects everything reports the first stateless error instead of looping", async () => {
  const seen: string[] = [];
  const fetch: McpFetch = async (_url, init) => {
    seen.push(init.method);
    return new Response("not here", { status: 404 });
  };
  await assert.rejects(
    new McpClient({ url: "https://mcp.test/mcp", fetch }).listTools(),
    (err) => err instanceof McpError && err.code === "MCP_HTTP_ERROR" && err.detail === "HTTP 404",
  );
  assert.deepEqual(seen, ["POST", "POST", "GET"]);
});

function controlledStream() {
  let push: (text: string) => void = () => undefined;
  let end: () => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      push = (text) => controller.enqueue(encoder.encode(text));
      end = () => controller.close();
    },
  });
  return { body, push: (text: string) => push(text), end: () => end() };
}

test("the deprecated HTTP+SSE transport sends to the announced endpoint and reads answers from the stream", async () => {
  const stream = controlledStream();
  const seen: Seen[] = [];
  const fetch: McpFetch = async (url, init) => {
    const body = parse(init);
    seen.push({ url, method: init.method, headers: init.headers, body });
    if (url === "https://mcp.test/sse" && init.method === "GET") {
      setTimeout(() => stream.push("event: endpoint\ndata: /messages?session=abc\n\n"), 5);
      return new Response(stream.body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url === "https://mcp.test/sse") return new Response("Method Not Allowed", { status: 405 });
    if (url !== "https://mcp.test/messages?session=abc") return new Response(null, { status: 404 });
    if (body?.method === "initialize") {
      setTimeout(() => {
        stream.push(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })}\n\n`);
        const result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "Old" } };
        stream.push(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);
      }, 5);
    }
    if (body?.method === "tools/call") {
      const reply = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "old but working" }] } };
      setTimeout(() => stream.push(`event: message\ndata: ${JSON.stringify(reply)}\n\n`), 5);
    }
    return new Response("Accepted", { status: 202 });
  };
  const client = new McpClient({ url: "https://mcp.test/sse", fetch, auth: staticAuth({ Authorization: "Bearer old" }) });
  assert.deepEqual(await client.callTool("echo", {}), { text: "old but working", isError: false });
  assert.deepEqual(client.connection, { transport: "sse", protocolVersion: "2024-11-05" });
  const posts = seen.filter((call) => call.url.startsWith("https://mcp.test/messages"));
  assert.deepEqual(
    posts.map((call) => call.body?.method ?? `answer:${String(call.body?.id)}`),
    ["initialize", "answer:99", "notifications/initialized", "tools/call"],
  );
  assert.deepEqual(posts[1]!.body, { jsonrpc: "2.0", id: 99, result: {} });
  assert.ok(seen.every((call) => call.headers.Authorization === "Bearer old"));
  assert.equal(await client.close(), false);
  stream.end();
});

test("an endpoint on another origin is refused", async () => {
  const fetch: McpFetch = async (url, init) => {
    if (init.method === "GET") {
      return new Response("event: endpoint\ndata: https://evil.test/messages\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(null, { status: 405 });
  };
  await assert.rejects(
    new McpClient({ url: "https://mcp.test/sse", fetch }).discover(),
    (err) => err instanceof McpError && (err.code === "MCP_HTTP_ERROR" || err.code === "MCP_PROTOCOL_ERROR"),
  );
});

test("a legacy event stream that closes early is resumed with Last-Event-ID", async () => {
  const seen: Seen[] = [];
  const fetch: McpFetch = async (url, init) => {
    const body = parse(init);
    seen.push({ url, method: init.method, headers: init.headers, body });
    if (body?.method === "initialize") {
      const result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "Polling" } };
      return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "Mcp-Session-Id": "p-1" } });
    }
    if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body?.method === "tools/call") {
      return new Response("id: evt-1\nretry: 1\ndata:\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (init.method === "GET" && init.headers["Last-Event-ID"] === "evt-1") {
      const reply = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "resumed" }] } };
      return new Response(`id: evt-2\ndata: ${JSON.stringify(reply)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(null, { status: 405 });
  };
  const client = new McpClient({
    url: "https://mcp.test/mcp",
    fetch,
    connection: { transport: "streamable_http", protocolVersion: "2025-11-25" },
  });
  assert.deepEqual(await client.callTool("slow", {}), { text: "resumed", isError: false });
  const resume = seen.find((call) => call.method === "GET")!;
  assert.equal(resume.headers["Mcp-Session-Id"], "p-1");
  assert.equal(resume.headers.Accept, "text/event-stream");
});

test("x-mcp-header parameters are mirrored into headers and encoded when needed", async () => {
  const schema = {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      options: { type: "object", properties: { dry: { type: "boolean", "x-mcp-header": "Dry-Run" } } },
      limit: { type: "integer", "x-mcp-header": "Limit" },
      query: { type: "string" },
    },
  };
  const server = modernServer();
  const client = new McpClient({ url: "https://mcp.test/mcp", fetch: server.fetch });
  await client.callTool("forecast", { region: "Zürich", options: { dry: true }, limit: 5, city: "Bern" }, undefined, schema);
  const headers = server.seen.at(-1)!.headers;
  assert.equal(headers["Mcp-Param-Region"], `=?base64?${Buffer.from("Zürich").toString("base64")}?=`);
  assert.equal(headers["Mcp-Param-Dry-Run"], "true");
  assert.equal(headers["Mcp-Param-Limit"], "5");
  assert.deepEqual(paramHeaders(headerParams(schema)!, { region: "eu-west1", limit: 1.5 }), { "Mcp-Param-Region": "eu-west1" });
  assert.equal(headerValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
  assert.equal(headerValue("=?base64?literal?="), "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
  assert.equal(headerValue("plain value"), "plain value");
});

test("tools with invalid x-mcp-header annotations are dropped", () => {
  const rejected: string[] = [];
  const specs = toolSpecs(
    [
      { name: "ok", inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "A" } } } },
      { name: "number", inputSchema: { type: "object", properties: { a: { type: "number", "x-mcp-header": "A" } } } },
      { name: "nested", inputSchema: { type: "object", properties: { a: { type: "array", items: { type: "string", "x-mcp-header": "A" } } } } },
      { name: "twice", inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "A" }, b: { type: "string", "x-mcp-header": "a" } } } },
      { name: "space", inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "Bad Name" } } } },
      { name: "named", inputSchema: { type: "object", properties: { "x-mcp-header": { type: "string" } } } },
    ],
    (name) => rejected.push(name),
  );
  assert.deepEqual(
    specs.map((spec) => spec.name),
    ["ok", "named"],
  );
  assert.deepEqual(rejected, ["number", "nested", "twice", "space"]);
});

test("a header mismatch reloads the tool schema and retries once", async () => {
  const fresh = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } };
  let calls = 0;
  const server = modernServer({
    result: (body) => {
      if (body.method === "tools/list") return { tools: [{ name: "forecast", inputSchema: fresh }] };
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const fetch: McpFetch = async (url, init) => {
    const body = parse(init);
    if (body?.method === "tools/call" && calls++ === 0) return rpcError(body.id, -32020, "Header mismatch: Mcp-Param-Region missing");
    return server.fetch(url, init);
  };
  const client = new McpClient({ url: "https://mcp.test/mcp", fetch });
  assert.deepEqual(await client.callTool("forecast", { region: "eu" }, undefined, { type: "object" }), { text: "ok", isError: false });
  assert.equal(server.seen.at(-1)!.headers["Mcp-Param-Region"], "eu");
});

test("interactive input requests and unknown result types fail the call", async () => {
  const ask = modernServer({ result: () => ({ resultType: "input_required", inputRequests: {} }) });
  await assert.rejects(
    new McpClient({ url: "https://mcp.test/mcp", fetch: ask.fetch }).callTool("x", {}),
    (err) => err instanceof McpError && err.code === "MCP_INPUT_REQUIRED",
  );
  const odd = modernServer({ result: () => ({ resultType: "mystery" }) });
  await assert.rejects(
    new McpClient({ url: "https://mcp.test/mcp", fetch: odd.fetch }).callTool("x", {}),
    (err) => err instanceof McpError && err.code === "MCP_PROTOCOL_ERROR",
  );
});

test("a rejected token is renewed once through the auth provider", async () => {
  const server = modernServer();
  let token = "old";
  const auth: McpAuth = {
    headers: async () => ({ Authorization: `Bearer ${token}` }),
    rejected: async (challenge) => {
      assert.equal(challenge?.resourceMetadata, "https://mcp.test/.well-known/oauth-protected-resource");
      token = "new";
      return true;
    },
  };
  const fetch: McpFetch = async (url, init) => {
    if (init.headers.Authorization !== "Bearer new") {
      return new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"' },
      });
    }
    return server.fetch(url, init);
  };
  const client = new McpClient({ url: "https://mcp.test/mcp", fetch, auth });
  assert.equal(await client.discover(), "Weather");
});

test("errors map to MCP error codes", async () => {
  const rejected: McpFetch = async () =>
    new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mcp", error="invalid_token"' } });
  await assert.rejects(
    new McpClient({ url: "https://mcp.test", fetch: rejected }).listTools(),
    (err) => err instanceof McpError && err.code === "MCP_AUTH_FAILED" && err.challenge?.error === "invalid_token",
  );

  const scoped: McpFetch = async () =>
    new Response("no", { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="files:write"' } });
  await assert.rejects(
    new McpClient({ url: "https://mcp.test", fetch: scoped }).listTools(),
    (err) => err instanceof McpError && err.code === "MCP_AUTH_SCOPE" && err.detail === "files:write",
  );

  const server = modernServer();
  const failing: McpFetch = async (url, init) => {
    const body = parse(init);
    if (body?.method !== "tools/call") return server.fetch(url, init);
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "unknown tool" } });
  };
  await assert.rejects(
    new McpClient({ url: "https://mcp.test", fetch: failing }).callTool("missing", {}),
    (err) => err instanceof McpError && err.code === "MCP_RPC_ERROR" && err.detail === "unknown tool",
  );

  const huge: McpFetch = async (_url, init) => {
    const body = parse(init);
    return Response.json({ jsonrpc: "2.0", id: body?.id, result: { padding: "a".repeat(2048) } });
  };
  await assert.rejects(
    new McpClient({ url: "https://mcp.test", fetch: huge, maxBytes: 512 }).discover(),
    (err) => err instanceof McpError && err.code === "MCP_RESPONSE_TOO_LARGE",
  );

  const html: McpFetch = async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(
    new McpClient({ url: "https://mcp.test", fetch: html }).discover(),
    (err) => err instanceof McpError && err.code === "MCP_PROTOCOL_ERROR",
  );

  const future: McpFetch = async (_url, init) =>
    rpcError(parse(init)?.id, -32022, "Unsupported protocol version", 400, { supported: ["2099-01-01"] });
  await assert.rejects(
    new McpClient({ url: "https://mcp.test", fetch: future }).discover(),
    (err) => err instanceof McpError && err.code === "MCP_VERSION_UNSUPPORTED",
  );
});

test("WWW-Authenticate parsing finds the Bearer challenge among others", () => {
  assert.deepEqual(
    bearerChallenge('Basic realm="x", Bearer resource_metadata="https://a.test/prm", scope="files:read files:write"'),
    { resourceMetadata: "https://a.test/prm", scope: "files:read files:write", error: "" },
  );
  assert.deepEqual(bearerChallenge('Bearer error="invalid_token", error_description="expired \\"now\\""'), {
    resourceMetadata: "",
    scope: "",
    error: "invalid_token",
  });
  assert.equal(bearerChallenge('Basic realm="x"'), null);
  assert.equal(bearerChallenge(null), null);
});

test("the SSE reader handles CRLF, comments, ids, retry, and multi-line data", async () => {
  const text = ": keep-alive\r\nid: 7\r\nretry: 250\r\nevent: message\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\ndata: tail";
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of [text.slice(0, 17), text.slice(17, 18), text.slice(18)]) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  const events = [];
  for await (const event of sseEvents(body, { total: 1024, event: 1024 })) events.push(event);
  assert.deepEqual(events, [
    { event: "message", data: '{"a":\n1}', id: "7", retry: 250 },
    { event: "message", data: "tail", id: null, retry: null },
  ]);
});

test("tool results become bounded text", () => {
  assert.deepEqual(toolOutcome({ content: [{ type: "text", text: "a" }, { type: "image", data: "xx", mimeType: "image/png" }] }), {
    text: "a\n\n[image omitted: image/png]",
    isError: false,
  });
  assert.deepEqual(toolOutcome({ content: [], structuredContent: { temp: 21 } }), { text: '{"temp":21}', isError: false });
  assert.equal(toolOutcome({ isError: true, content: [] }).isError, true);
  assert.equal(
    toolOutcome({ content: [{ type: "resource", resource: { uri: "file:///a", text: "inline" } }] }).text,
    "inline",
  );
  const long = toolOutcome({ content: [{ type: "text", text: "x".repeat(MCP_MAX_TOOL_RESULT_CHARS + 10) }] }).text;
  assert.ok(long.endsWith("[truncated: 10 more characters]"));
  assert.equal(long.length, MCP_MAX_TOOL_RESULT_CHARS + "\n[truncated: 10 more characters]".length);
});

test("remote servers cannot classify their own tools, and their annotations stay hints", async () => {
  const server = modernServer({
    result: (body) =>
      body.method === "tools/list"
        ? {
            tools: [
              { name: "read_only", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
              { name: "spoofed", action: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
              { name: "writes", hint: "read", inputSchema: { type: "object" }, annotations: { destructiveHint: false } },
              { name: "plain", inputSchema: { type: "object" } },
            ],
          }
        : { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} } },
  });
  const client = new McpClient({ url: "https://mcp.test/mcp", fetch: server.fetch });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((item) => [item.name, item.action ?? null, item.hint ?? null]),
    [
      ["read_only", null, "read"],
      ["spoofed", null, "delete"],
      ["writes", null, "write"],
      ["plain", null, null],
    ],
  );
  assert.deepEqual(toolSpecs(tools).map((item) => item.hint ?? null), ["read", "delete", "write", null]);
  assert.deepEqual(toolSpecs([{ name: "hosted", action: "write", hint: "read" }])[0], {
    name: "hosted",
    title: "",
    description: "",
    inputSchema: { type: "object", properties: {} },
    action: "write",
  });
  assert.equal(annotationHint({ readOnlyHint: true, destructiveHint: true }), "read");
  assert.equal(annotationHint({ destructiveHint: true }), "delete");
  assert.equal(annotationHint({ title: "x" }), undefined);
  assert.equal(annotationHint(null), undefined);
});

test("tool specs drop invalid and duplicate tools and force object schemas", () => {
  const specs = toolSpecs([
    { name: "a", inputSchema: { type: "object", properties: {} } },
    { name: "a", inputSchema: { type: "object" } },
    { name: "b" },
    { description: "nameless" },
    { name: "x".repeat(200) },
    "junk",
  ]);
  assert.deepEqual(
    specs.map((spec) => [spec.name, spec.inputSchema.type]),
    [
      ["a", "object"],
      ["b", "object"],
    ],
  );
});
