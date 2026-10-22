import { gateway, gatewayRequest, groupRow, MODEL, resetGateway, UPSTREAM } from "./support/gateway-harness";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { CODEX_BASE_INSTRUCTIONS, CODEX_COMPACT_INSTRUCTIONS } from "@/lib/gateway/catalog/codex-instructions";
import { CODEX_CATALOG_LIMIT, codexCatalog } from "@/lib/gateway/catalog/codex-catalog";
import { routeCatalogFacts } from "@/lib/gateway/catalog/model-context";
import { clientTools, localToolNames, namespacedToolName, withToolNamespaces } from "@/lib/gateway/protocols/responses-tools";
import type { JsonMap } from "@/types/gateway";

const SPAWN = "multi_agent_v1__spawn_agent";

const execTool = { type: "function", name: "exec_command", parameters: { type: "object", properties: {} } };
const namespaceTool = {
  type: "namespace",
  name: "multi_agent_v1",
  description: "Sub-agents",
  tools: [{ type: "function", name: "spawn_agent", description: "Start a sub-agent", parameters: { type: "object", properties: {} } }],
};

function codexBody(change: JsonMap = {}): JsonMap {
  return {
    model: MODEL,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "medium", context: "all_turns" },
    client_metadata: { session: "s-1" },
    input: [
      { type: "additional_tools", role: "developer", tools: [execTool, namespaceTool] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Start a helper" }] },
      { type: "function_call", call_id: "call_0", name: "spawn_agent", namespace: "multi_agent_v1", arguments: "{}" },
      { type: "function_call_output", call_id: "call_0", output: "started" },
    ],
    tools: [{ type: "web_search", external_web_access: false }],
    ...change,
  };
}

function toolCallReply(name: string): Response {
  return Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: "{\"task\":\"x\"}" } }] },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

function toolCallStream(name: string): Response {
  const chunks = [
    { id: "c", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }] } }] },
    { id: "c", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"task\":\"x\"}" } }] } }] },
    { id: "c", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "c", object: "chat.completion.chunk", model: MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ];
  const text = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function sseEvents(text: string): JsonMap[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as JsonMap);
}

beforeEach(() => {
  resetGateway();
  gateway.groups.clear();
  gateway.groups.set(MODEL, groupRow(MODEL));
});

test("namespaced tool names join namespace and tool, stay valid, and keep qualified names", () => {
  assert.equal(namespacedToolName("multi_agent_v1", "spawn_agent"), SPAWN);
  assert.equal(namespacedToolName("mcp__docs__", "search"), "mcp__docs__search");
  assert.equal(namespacedToolName("mcp__docs", "mcp__docs__search"), "mcp__docs__search");
  const long = namespacedToolName("a".repeat(40), "b".repeat(40));
  assert.equal(long.length, 64);
  assert.match(long, /^[A-Za-z0-9_-]+_[0-9a-f]{8}$/);
  assert.equal(long, namespacedToolName("a".repeat(40), "b".repeat(40)));
  assert.match(namespacedToolName("team tools", "look.up"), /^team_tools__look_up_[0-9a-f]{8}$/);
});

test("client tools merge additional tools, flatten namespaces, and drop hosted web search", () => {
  const { body, namespaces } = clientTools(codexBody());
  assert.deepEqual(
    (body.tools as JsonMap[]).map((tool) => tool.name),
    ["exec_command", SPAWN],
  );
  assert.deepEqual(namespaces.get(SPAWN), { namespace: "multi_agent_v1", name: "spawn_agent" });
  const input = body.input as JsonMap[];
  assert.equal(input.some((item) => item.type === "additional_tools"), false);
  const call = input.find((item) => item.type === "function_call")!;
  assert.equal(call.name, SPAWN);
  assert.equal("namespace" in call, false);
  const duplicate = clientTools({
    model: MODEL,
    input: [{ type: "additional_tools", tools: [{ ...execTool, description: "later" }] }],
    tools: [execTool],
  });
  assert.deepEqual(duplicate.body.tools, [execTool]);
  const plain = clientTools({ model: MODEL, input: "hi" });
  assert.equal("tools" in plain.body, false);
  assert.equal(plain.namespaces.size, 0);
  const choice = clientTools({ model: MODEL, input: "hi", tool_choice: { type: "function", name: "spawn_agent", namespace: "multi_agent_v1" } });
  assert.deepEqual(choice.body.tool_choice, { type: "function", name: SPAWN });
});

test("local tool names restore namespaces in responses and stream events", async () => {
  const { namespaces } = clientTools(codexBody());
  const call = { type: "function_call", name: SPAWN, call_id: "c", arguments: "{}" };
  const other = { type: "function_call", name: "exec_command", call_id: "d", arguments: "{}" };
  assert.deepEqual(localToolNames({ object: "response", output: [call, other] }, namespaces).output, [
    { ...call, name: "spawn_agent", namespace: "multi_agent_v1" },
    other,
  ]);
  assert.deepEqual(localToolNames({ type: "response.output_item.done", item: call }, namespaces).item, {
    ...call,
    name: "spawn_agent",
    namespace: "multi_agent_v1",
  });
  const done = localToolNames({ type: "response.function_call_arguments.done", name: SPAWN, arguments: "{}" }, namespaces);
  assert.equal(done.name, "spawn_agent");
  assert.equal(done.namespace, "multi_agent_v1");
  const unchanged = new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
  assert.equal(await withToolNamespaces(unchanged, namespaces), unchanged);
  const plain = Response.json({ output: [call] });
  assert.equal(await withToolNamespaces(plain, new Map()), plain);
});

test("responses accept Codex requests and answer namespaced calls with their namespace", async () => {
  gateway.reply = () => toolCallReply(SPAWN);
  const { POST } = await import("@/app/api/v1/responses/route");
  const res = await POST(gatewayRequest("/api/v1/responses", codexBody()));
  assert.equal(res.status, 200);
  const upstream = gateway.upstream.find((call) => call.url === `${UPSTREAM}/chat/completions`);
  assert.ok(upstream?.body);
  const tools = (upstream.body.tools as JsonMap[]).map((tool) => (tool.function as JsonMap).name);
  assert.deepEqual(tools, ["exec_command", SPAWN]);
  const history = (upstream.body.messages as JsonMap[]).find((message) => Array.isArray(message.tool_calls));
  assert.equal(((history?.tool_calls as JsonMap[])[0]!.function as JsonMap).name, SPAWN);
  const json = (await res.json()) as JsonMap;
  const call = (json.output as JsonMap[]).find((item) => item.type === "function_call");
  assert.equal(call?.name, "spawn_agent");
  assert.equal(call?.namespace, "multi_agent_v1");
  assert.equal(call?.arguments, "{\"task\":\"x\"}");
});

test("streamed Codex responses restore namespaces in every event", async () => {
  gateway.reply = () => toolCallStream(SPAWN);
  const { POST } = await import("@/app/api/v1/responses/route");
  const res = await POST(gatewayRequest("/api/v1/responses", codexBody({ stream: true })));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = sseEvents(await res.text());
  const added = events.find((event) => event.type === "response.output_item.added" && (event.item as JsonMap).type === "function_call");
  assert.deepEqual([(added?.item as JsonMap).name, (added?.item as JsonMap).namespace], ["spawn_agent", "multi_agent_v1"]);
  const completed = events.find((event) => event.type === "response.completed");
  const output = ((completed?.response as JsonMap).output as JsonMap[]).find((item) => item.type === "function_call");
  assert.deepEqual([output?.name, output?.namespace], ["spawn_agent", "multi_agent_v1"]);
  const calls = events.flatMap((event) => [
    event.item as JsonMap | undefined,
    ...(((event.response as JsonMap | undefined)?.output as JsonMap[] | undefined) ?? []),
    event.type === "response.function_call_arguments.done" ? event : undefined,
  ]);
  assert.equal(calls.some((call) => call?.name === SPAWN), false);
});

test("catalog facts take the smallest known window and the confirmed speed tiers per alias and pool", () => {
  const discovered = (id: string, contextLength: number, change: JsonMap = {}) => [
    { id, name: id, ownedBy: "x", contextLength, costInputPer1k: 0, costOutputPer1k: 0, priceSource: "none", ...change },
  ];
  const facts = routeCatalogFacts([
    {
      alias: "claude-sonnet",
      deployments: [
        { kind: "claude", model: "claude-sonnet-4-6", provider: { kind: "claude", internal: false, discovered: discovered("claude-sonnet-4-6", 200_000) } },
        { kind: "anthropic", model: "claude-sonnet-4-6", provider: { kind: "anthropic", internal: false, discovered: discovered("claude-sonnet-4-6", 1_000_000) } },
        { kind: "anthropic", model: "claude-sonnet-4-6", provider: { kind: "anthropic", internal: false, discovered: discovered("claude-sonnet-4-6", 400_000) } },
        { kind: "anthropic", model: "claude-sonnet-4-6", provider: { kind: "anthropic", internal: true, discovered: discovered("claude-sonnet-4-6", 100_000) } },
      ],
    },
    {
      alias: "gpt-6-astra",
      deployments: [
        {
          kind: "codex",
          model: "gpt-6-astra",
          provider: { kind: "codex", internal: false, discovered: discovered("gpt-6-astra", 272_000, { serviceTiers: ["priority", "ultrafast"] }) },
        },
        { kind: "openai", model: "gpt-6-astra", provider: { kind: "openai", internal: false, discovered: [] } },
      ],
    },
    {
      alias: "gpt-plus",
      deployments: [
        { kind: "codex", model: "gpt-plus", provider: { kind: "codex", internal: false, discovered: discovered("gpt-plus", 0, { serviceTiers: [] }) } },
        { kind: "codex", model: "gpt-unknown", provider: { kind: "codex", internal: false, discovered: [] } },
      ],
    },
    { alias: "unknown", deployments: [{ kind: "openai_compat", model: "m", provider: null }] },
  ]);
  assert.equal(facts.windows.subscription.get("claude-sonnet"), 200_000);
  assert.equal(facts.windows.api.get("claude-sonnet"), 400_000);
  assert.equal(facts.windows.internal.get("claude-sonnet"), 100_000);
  assert.equal(facts.windows.api.has("unknown"), false);
  assert.deepEqual(facts.speeds.subscription.get("claude-sonnet"), []);
  assert.deepEqual(facts.speeds.subscription.get("gpt-6-astra"), ["fast", "ultrafast"]);
  assert.deepEqual(facts.speeds.api.get("gpt-6-astra"), ["fast"]);
  assert.deepEqual(facts.speeds.subscription.get("gpt-plus"), []);
  assert.deepEqual(facts.speeds.api.get("unknown"), []);
});

test("the Codex catalog lists chat models with Codex metadata and the full Codex prompt", () => {
  const entries: JsonMap[] = [
    { id: "claude-sonnet", display_name: "Claude Sonnet", route: "subscription" },
    { id: "grok-4.20-non-reasoning", display_name: "", route: "subscription" },
    { id: "grok-imagine-image", display_name: "Grok Imagine", route: "subscription" },
    { id: "api/claude-sonnet", display_name: "Claude Sonnet (API)", route: "api" },
  ];
  const facts = {
    windows: {
      api: new Map([["claude-sonnet", 1_000_000]]),
      subscription: new Map([["claude-sonnet", 200_000]]),
      internal: new Map(),
    },
    speeds: { api: new Map(), subscription: new Map(), internal: new Map() },
  };
  const catalog = codexCatalog(entries, "subscription", facts);
  const models = catalog.models as JsonMap[];
  assert.deepEqual(models.map((model) => model.slug), ["claude-sonnet", "grok-4.20-non-reasoning", "api/claude-sonnet"]);
  const [sonnet, plain, api] = models as [JsonMap, JsonMap, JsonMap];
  assert.equal(sonnet.display_name, "Claude Sonnet");
  assert.equal(sonnet.visibility, "list");
  assert.equal(sonnet.shell_type, "shell_command");
  assert.equal(sonnet.supported_in_api, true);
  assert.equal(sonnet.apply_patch_tool_type, null);
  assert.equal(sonnet.base_instructions, CODEX_BASE_INSTRUCTIONS);
  assert.equal(sonnet.context_window, 200_000);
  assert.equal(sonnet.default_reasoning_level, "medium");
  assert.deepEqual((sonnet.supported_reasoning_levels as JsonMap[]).map((level) => level.effort), ["low", "medium", "high"]);
  assert.deepEqual(sonnet.truncation_policy, { mode: "bytes", limit: 10_000 });
  assert.equal(plain.display_name, "grok-4.20-non-reasoning");
  assert.deepEqual(plain.supported_reasoning_levels, []);
  assert.equal(plain.default_reasoning_level, null);
  assert.equal("context_window" in plain, false);
  assert.equal(api.context_window, 1_000_000);
  assert.notEqual(api.description, sonnet.description);
  assert.deepEqual(models.map((model) => model.priority), [0, 1, 2]);
  assert.equal((codexCatalog(entries, "api", facts).models as JsonMap[])[0]!.description, null);
});

test("the Codex catalog offers Fast and Ultra Fast where a route confirms them and keeps variants at their own speed", () => {
  const entries: JsonMap[] = [
    { id: "gpt-6-astra", display_name: "GPT-6 Astra", route: "subscription" },
    { id: "gpt-6-astra-fast", display_name: "GPT-6 Astra (Fast)", route: "subscription", variant: "fast" },
    { id: "api/gpt-6-astra", display_name: "GPT-6 Astra (API)", route: "api" },
  ];
  const facts = {
    windows: { api: new Map(), subscription: new Map([["gpt-6-astra", 272_000]]), internal: new Map() },
    speeds: {
      api: new Map<string, ("fast" | "ultrafast")[]>([["gpt-6-astra", ["fast"]]]),
      subscription: new Map<string, ("fast" | "ultrafast")[]>([["gpt-6-astra", ["fast", "ultrafast"]]]),
      internal: new Map(),
    },
  };
  const [base, variant, api] = codexCatalog(entries, "subscription", facts).models as [JsonMap, JsonMap, JsonMap];
  assert.deepEqual((base.service_tiers as JsonMap[]).map((tier) => tier.id), ["priority", "ultrafast"]);
  assert.deepEqual(base.additional_speed_tiers, ["fast"]);
  assert.deepEqual(variant.service_tiers, []);
  assert.deepEqual(variant.additional_speed_tiers, []);
  assert.equal(variant.context_window, 272_000);
  assert.deepEqual((api.service_tiers as JsonMap[]).map((tier) => tier.name), ["Fast"]);
});

test("the Codex catalog falls back to the compact prompt when the full one would pass the size cap", () => {
  const many = Array.from({ length: Math.ceil(CODEX_CATALOG_LIMIT / CODEX_BASE_INSTRUCTIONS.length) + 1 }, (_, index) => ({
    id: `model-${index}`,
    display_name: "",
  }));
  const catalog = codexCatalog(many, "api", {
    windows: { api: new Map(), subscription: new Map(), internal: new Map() },
    speeds: { api: new Map(), subscription: new Map(), internal: new Map() },
  });
  const models = catalog.models as JsonMap[];
  assert.equal(models.length, many.length);
  assert.equal(models.every((model) => model.base_instructions === CODEX_COMPACT_INSTRUCTIONS), true);
  assert.ok(Buffer.byteLength(JSON.stringify(catalog)) <= CODEX_CATALOG_LIMIT);
});

test("the models list answers Codex in its catalog format when client_version is sent", async () => {
  const { GET } = await import("@/app/api/v1/models/route");
  const request = (query: string) =>
    new Request(`http://hub.local/api/v1/models${query}`, { headers: { authorization: "Bearer sk-hub-test" } });
  const codex = (await (await GET(request("?client_version=0.162.1"))).json()) as JsonMap;
  const slugs = (codex.models as JsonMap[]).map((model) => model.slug);
  assert.ok(slugs.includes(MODEL));
  assert.equal("data" in codex, false);
  const openai = (await (await GET(request(""))).json()) as JsonMap;
  assert.equal(openai.object, "list");
  assert.ok((openai.data as JsonMap[]).some((model) => model.id === MODEL));
});
