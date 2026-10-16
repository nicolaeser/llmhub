import assert from "node:assert/strict";
import test from "node:test";
import { buildHostedRequest, callHosted, cleanToolName, mergeTools, readDraft, readPick } from "@/lib/mcp/hosted";
import type { HostedTool, McpFetch } from "@/types/mcp";

const pet: HostedTool = {
  name: "get_pet",
  title: "Get pet",
  description: "Read one pet",
  action: "read",
  method: "GET",
  path: "/pets/{id}",
  query: [],
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

test("readDraft reads fenced JSON, repairs tool names, and adds path parameters", () => {
  const parsed = readDraft(fenced);
  assert.equal(parsed.cut, false);
  assert.equal(parsed.server?.name, "Pets");
  assert.deepEqual(
    parsed.tools.map((tool) => tool.name),
    ["get_pet", "bad_name", "get_pet_2"],
  );
  assert.deepEqual(parsed.tools[0]!.inputSchema.properties, { id: { type: "string" } });
  assert.deepEqual(parsed.tools[0]!.inputSchema.required, ["id"]);
  assert.equal(parsed.tools[2]!.method, "POST");
  assert.deepEqual(readDraft("not json"), { server: null, tools: [], cut: true });
  const empty = readDraft('{"name":"Pets","baseUrl":"https://api.example.com","tools":[{"name":"x","action":"read","method":"HEAD","path":"/x"}]}');
  assert.equal(empty.server?.name, "Pets");
  assert.deepEqual(empty.tools, []);
});

test("readDraft keeps the complete tools of an answer that stopped early", () => {
  const cut = `{"name":"Shop","description":"","baseUrl":"https://api.example.com/v2","authType":"apiKey","authHeader":"X-Key","tools":[
  {"name":"listOrders","action":"read","method":"get","path":"https://api.example.com/v2/orders?status={status}&limit=10"},
  {"name":"get-order","method":"GET","path":"/orders/:orderId"},
  {"name":"update_order","action":"write","method":"PATCH","path":"/orders/{order-id}","inputSchema":{"type":"object","properties":{"order-id":{"type":"string","description":"Order"},"note":{"type":"string"}}}},
  {"name":"delete_order","action":"delete","method":"DELETE","path":"/ord`;
  const parsed = readDraft(cut);
  assert.equal(parsed.cut, true);
  assert.equal(parsed.server?.authType, "header");
  assert.equal(parsed.server?.authHeader, "X-Key");
  assert.deepEqual(
    parsed.tools.map((tool) => [tool.name, tool.method, tool.path, tool.action]),
    [
      ["listOrders", "GET", "/orders", "read"],
      ["get_order", "GET", "/orders/{orderId}", "read"],
      ["update_order", "PATCH", "/orders/{order_id}", "write"],
    ],
  );
  assert.deepEqual(Object.keys(parsed.tools[0]!.inputSchema.properties as object), ["status", "limit"]);
  assert.deepEqual(parsed.tools[0]!.query, ["status", "limit"]);
  assert.deepEqual(parsed.tools[2]!.inputSchema.properties, {
    note: { type: "string" },
    order_id: { type: "string", description: "Order" },
  });
});

test("mergeTools skips repeated calls and renames clashing names", () => {
  const list = { ...pet, name: "list_pets", path: "/pets" };
  const merged = mergeTools([pet], [pet, list, { ...list, method: "POST", action: "write" }]);
  assert.deepEqual(
    merged.map((tool) => tool.name),
    ["get_pet", "list_pets", "list_pets_2"],
  );
  assert.equal(mergeTools([], [pet, list], 1).length, 1);
  assert.equal(cleanToolName("pets.list-all"), "pets_list_all");
  assert.equal(cleanToolName("2fa/reset"), "op_2fa_reset");
});

test("readPick keeps only known operation names", () => {
  const tools = [pet, { ...pet, name: "list_pets", path: "/pets" }];
  assert.deepEqual(readPick('{"keep":["list_pets","nope"]}', tools), ["list_pets"]);
  assert.equal(readPick('{"keep":[]}', tools), null);
  assert.equal(readPick("no", tools), null);
});

test("a hosted server accepts per-key tool and action blocks", async () => {
  const { hostedServerSchema } = await import("@/schemas/mcp");
  const parsed = hostedServerSchema.parse({
    name: "Pets",
    description: "",
    baseUrl: "https://api.example.com",
    internal: false,
    authType: "none",
    tools: [pet],
    global: false,
    assignments: [{ scope: "key", id: "key_1", mode: "allow", blockedTools: ["get_pet"], blockedActions: ["delete"] }],
  });
  assert.equal(parsed.assignments[0]?.scope, "key");
  assert.deepEqual(parsed.assignments[0]?.blockedActions, ["delete"]);
  assert.equal(parsed.assignments[0]?.roleKey, "");
  assert.equal(parsed.template, false);
  const bare = hostedServerSchema.parse({
    name: "Pets",
    description: "",
    baseUrl: "https://api.example.com",
    internal: false,
    authType: "none",
    tools: [pet],
  });
  assert.equal(bare.global, false);
  assert.equal(bare.template, false);
  assert.deepEqual(bare.assignments, []);
  const keyed = { name: "Pets", description: "", baseUrl: "https://api.example.com", internal: false, authType: "bearer", tools: [pet] };
  assert.equal(hostedServerSchema.safeParse(keyed).success, false);
  assert.equal(hostedServerSchema.safeParse({ ...keyed, template: true }).success, true);
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
  const tagged = buildHostedRequest(
    "https://api.example.com",
    { ...create, query: ["dryRun"], inputSchema: { type: "object", properties: { name: {}, dryRun: {} } } },
    { name: "Ada", dryRun: true },
  );
  assert.deepEqual(tagged, { url: "https://api.example.com/pets?dryRun=true", method: "POST", body: '{"name":"Ada"}' });
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
