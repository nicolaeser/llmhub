import assert from "node:assert/strict";
import test from "node:test";
import { buildHostedRequest, callHosted, parseDraft } from "@/lib/mcp/hosted";
import type { HostedTool, McpFetch } from "@/types/mcp";

const pet: HostedTool = {
  name: "get_pet",
  title: "Get pet",
  description: "Read one pet",
  action: "read",
  method: "GET",
  path: "/pets/{id}",
  inputSchema: { type: "object", properties: { id: { type: "string" }, limit: { type: "number" } } },
};

const fenced = `Here is the server.
\`\`\`json
{"name":"Pets","description":"Pet store","baseUrl":"https://api.example.com/v1","internal":false,"authType":"bearer","notes":"read only","tools":[
  {"name":"get_pet","title":"Get","description":"Read one","action":"read","method":"GET","path":"/pets/{id}","inputSchema":{"type":"object","properties":{}}},
  {"name":"bad-name","action":"read","method":"GET","path":"/nope"},
  {"name":"get_pet","action":"write","method":"POST","path":"/pets"}
]}
\`\`\``;

test("parseDraft reads fenced JSON, drops bad tools, and adds path parameters", () => {
  const parsed = parseDraft(fenced);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.draft.name, "Pets");
  assert.equal(parsed.draft.tools.length, 1);
  assert.equal(parsed.draft.tools[0]!.name, "get_pet");
  assert.deepEqual(parsed.draft.tools[0]!.inputSchema.properties, { id: { type: "string" } });
  const garbage = parseDraft("not json");
  assert.deepEqual(garbage, { ok: false, code: "MCP_BUILDER_DRAFT" });
  const empty = parseDraft('{"name":"Pets","baseUrl":"https://api.example.com","tools":[{"name":"bad-name","action":"read","method":"GET","path":"/x"}]}');
  assert.deepEqual(empty, { ok: false, code: "MCP_BUILDER_EMPTY" });
});

test("buildHostedRequest keeps the base path and sends the leftover fields", () => {
  const get = buildHostedRequest("https://api.example.com/v1/", pet, { id: "a/b", limit: 5, extra: "no" });
  assert.deepEqual(get, { url: "https://api.example.com/v1/pets/a%2Fb?limit=5", method: "GET" });
  const create: HostedTool = {
    ...pet,
    name: "create_pet",
    action: "write",
    method: "POST",
    path: "/pets",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  };
  const post = buildHostedRequest("https://api.example.com/v1", create, { name: "Ada", extra: "no" });
  assert.deepEqual(post, { url: "https://api.example.com/v1/pets", method: "POST", body: '{"name":"Ada"}' });
  assert.deepEqual(buildHostedRequest("https://api.example.com", { ...pet, path: "/pets/../admin" }, { id: "1" }), { error: "VALIDATION" });
});

test("callHosted sends the sealed header and refuses private addresses", async () => {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = [];
  const fetchImpl: McpFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"ok":true}', { status: 200 });
  };
  const ok = await callHosted(
    "https://api.example.com/v1",
    false,
    { tools: [pet] },
    "get_pet",
    { id: "7" },
    AbortSignal.timeout(1000),
    fetchImpl,
    { Authorization: "Bearer secret" },
  );
  assert.deepEqual(ok, { text: '{"ok":true}', isError: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.example.com/v1/pets/7");
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.headers.Authorization, "Bearer secret");
  calls.length = 0;
  const blocked = await callHosted(
    "https://127.0.0.1",
    false,
    { tools: [pet] },
    "get_pet",
    { id: "1" },
    AbortSignal.timeout(1000),
    fetchImpl,
    {},
  );
  assert.deepEqual(blocked, { text: "MCP_URL_BLOCKED", isError: true });
  assert.equal(calls.length, 0);
});
