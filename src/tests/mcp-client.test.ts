import assert from "node:assert/strict";
import test from "node:test";
import { McpClient, MCP_MAX_TOOL_RESULT_CHARS, toolOutcome, toolSpecs } from "@/lib/mcp/client";
import { McpError } from "@/lib/mcp/errors";
import type { JsonMap } from "@/types/gateway";
import type { McpFetch } from "@/types/mcp";

type Seen = { method: string; headers: Record<string, string>; body: JsonMap | null };

function sse(events: unknown[]): Response {
  const text = events.map((event) => `event: message\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeServer(options: { sse?: boolean; expireOnce?: boolean; session?: string } = {}) {
  const seen: Seen[] = [];
  let expired = false;
  let sessions = 0;
  const fetch: McpFetch = async (_url, init) => {
    const body = init.body ? (JSON.parse(init.body) as JsonMap) : null;
    seen.push({ method: init.method, headers: init.headers, body });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const rpc = body?.method;
    if (rpc === "initialize") {
      sessions += 1;
      return Response.json(
        { jsonrpc: "2.0", id: body!.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Weather" } } },
        { headers: { "Mcp-Session-Id": `${options.session ?? "s"}-${sessions}` } },
      );
    }
    if (rpc === "notifications/initialized") return new Response(null, { status: 202 });
    if (options.expireOnce && !expired && rpc === "tools/list") {
      expired = true;
      return new Response("gone", { status: 404 });
    }
    if (rpc === "tools/list") {
      const cursor = (body!.params as JsonMap).cursor;
      const result = cursor
        ? { tools: [{ name: "forecast", description: "Forecast", inputSchema: { type: "object", properties: { city: { type: "string" } } } }] }
        : { tools: [{ name: "now", inputSchema: { type: "object" } }, { name: "", inputSchema: {} }], nextCursor: "page-2" };
      return Response.json({ jsonrpc: "2.0", id: body!.id, result });
    }
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

test("the client initializes once, sends the session id, and pages through tools/list", async () => {
  const server = fakeServer();
  const client = new McpClient({ url: "https://mcp.test/mcp", headers: { Authorization: "Bearer t" }, fetch: server.fetch });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["now", "forecast"],
  );
  assert.deepEqual(tools[0]!.inputSchema, { type: "object" });
  const methods = server.seen.map((call) => call.body?.method);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/list"]);
  const init = server.seen[0]!;
  assert.equal(init.headers.Accept, "application/json, text/event-stream");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers.Authorization, "Bearer t");
  assert.equal(init.headers["Mcp-Session-Id"], undefined);
  assert.deepEqual((init.body!.params as JsonMap).clientInfo, { name: "llmhub", version: "1.0.0" });
  for (const later of server.seen.slice(1)) {
    assert.equal(later.headers["Mcp-Session-Id"], "s-1");
    assert.equal(later.headers["MCP-Protocol-Version"], "2025-06-18");
  }
  assert.deepEqual(server.seen[3]!.body!.params, { cursor: "page-2" });
  assert.equal(server.seen[1]!.body!.id, undefined);

  assert.equal(await client.close(), true);
  const last = server.seen.at(-1)!;
  assert.equal(last.method, "DELETE");
  assert.equal(last.headers["Mcp-Session-Id"], "s-1");
});

test("tools/call reads a text/event-stream answer and skips interleaved notifications", async () => {
  const server = fakeServer({ sse: true });
  const client = new McpClient({ url: "https://mcp.test/mcp", headers: {}, fetch: server.fetch });
  const outcome = await client.callTool("forecast", { city: "Bern" });
  assert.deepEqual(outcome, { text: "Sunny in Bern", isError: false });
  const call = server.seen.find((item) => item.body?.method === "tools/call")!;
  assert.deepEqual(call.body!.params, { name: "forecast", arguments: { city: "Bern" } });
});

test("an expired session (404) re-initializes once and retries", async () => {
  const server = fakeServer({ expireOnce: true });
  const client = new McpClient({ url: "https://mcp.test/mcp", headers: {}, fetch: server.fetch });
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
  const inits = server.seen.filter((item) => item.body?.method === "initialize");
  assert.equal(inits.length, 2);
  const lists = server.seen.filter((item) => item.body?.method === "tools/list");
  assert.equal(lists.at(-1)!.headers["Mcp-Session-Id"], "s-2");
});

test("errors map to MCP error codes", async () => {
  const rejected: McpFetch = async () => new Response("no", { status: 401 });
  await assert.rejects(
    new McpClient({ url: "https://mcp.test", headers: {}, fetch: rejected }).listTools(),
    (err) => err instanceof McpError && err.code === "MCP_AUTH_FAILED",
  );

  const server = fakeServer();
  const failing: McpFetch = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as JsonMap;
    if (body.method !== "tools/call") return server.fetch(url, init);
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "unknown tool" } });
  };
  await assert.rejects(
    new McpClient({ url: "https://mcp.test", headers: {}, fetch: failing }).callTool("missing", {}),
    (err) => err instanceof McpError && err.code === "MCP_RPC_ERROR" && err.detail === "unknown tool",
  );

  const huge: McpFetch = async (_url, init) => {
    const body = JSON.parse(init.body ?? "{}") as JsonMap;
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "x", padding: "a".repeat(2048) } });
  };
  await assert.rejects(
    new McpClient({ url: "https://mcp.test", headers: {}, fetch: huge, maxBytes: 512 }).initialize(),
    (err) => err instanceof McpError && err.code === "MCP_RESPONSE_TOO_LARGE",
  );

  const html: McpFetch = async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(
    new McpClient({ url: "https://mcp.test", headers: {}, fetch: html }).initialize(),
    (err) => err instanceof McpError && err.code === "MCP_PROTOCOL_ERROR",
  );
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
