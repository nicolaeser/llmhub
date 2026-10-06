import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ASSISTANT_EXPLAIN,
  ASSISTANT_PAGES,
  callMcpTool,
  isWriteTool,
  listMcpTools,
  mcpToolsForModel,
  nextSetupStep,
  toPublicKeyView,
} from "@/lib/assistant/mcp";
import {
  completionText,
  parseAssistantLocale,
  parseAssistantModel,
  parseAssistantWrite,
  parseClientMessages,
  parseToolArgs,
  parseToolCalls,
  redactSecrets,
} from "@/lib/assistant/parse";
import { consumeSseBuffer } from "@/lib/assistant/sse";
import {
  applyAssistantEvent,
  groupAssistantParts,
  messageText,
  settleAssistantMessage,
  toolArgsPreview,
  toolErrorCode,
  wireMessage,
} from "@/lib/assistant/transcript";
import {
  errorSamples,
  parseLogSearch,
  parseUsageBreakdown,
  sortUsageRows,
} from "@/lib/assistant/insights";
import { ASSISTANT_STEP_LIMIT_NOTE, assistantSystemPrompt } from "@/lib/assistant/prompt";
import { PERMISSIONS, roleTemplates } from "@/lib/auth/permissions";
import type { AssistantChatMessage, AssistantContext } from "@/types/assistant";

const ctx: AssistantContext = {
  userId: "user-1",
  permissions: Object.values(PERMISSIONS),
  teamId: "",
  orgId: "",
  locale: "en",
  allowWrite: true,
};

test("nextSetupStep follows provider then model then key", () => {
  assert.equal(
    nextSetupStep({ providers: 0, models: 0, keys: 0 }),
    "connect_provider",
  );
  assert.equal(
    nextSetupStep({ providers: 1, models: 0, keys: 0 }),
    "add_model",
  );
  assert.equal(
    nextSetupStep({ providers: 1, models: 1, keys: 0 }),
    "create_key",
  );
  assert.equal(
    nextSetupStep({ providers: 1, models: 1, keys: 1 }),
    "ready",
  );
});

test("MCP catalog exposes setup, explain, and write tools", () => {
  const names = listMcpTools().map((tool) => tool.name);
  for (const name of [
    "get_setup_status",
    "get_overview",
    "list_provider_kinds",
    "list_providers",
    "list_models",
    "list_keys",
    "search_logs",
    "usage_breakdown",
    "explain",
    "open_page",
    "create_provider",
    "create_model",
    "create_key",
  ]) {
    assert.ok(names.includes(name), name);
  }
  const keys = listMcpTools().find((tool) => tool.name === "list_keys");
  assert.match(keys?.description ?? "", /prefix/i);
  assert.match(keys?.description ?? "", /secret/i);
  const modelTools = mcpToolsForModel();
  assert.equal(modelTools.length, names.length);
  assert.equal(modelTools[0]?.type, "function");
});

test("explain covers setup tenancy keys providers models v1 playground", async () => {
  const topics = [
    "setup",
    "tenancy",
    "keys",
    "providers",
    "models",
    "v1",
    "playground",
    "budgets",
    "guardrails",
    "cache",
    "router",
    "logging",
    "usage",
    "roles",
    "sso",
  ];
  for (const topic of topics) {
    assert.ok(ASSISTANT_EXPLAIN[topic], topic);
  }
  for (const topic of topics) {
    const { result } = await callMcpTool("explain", { topic }, ctx);
    const rec = result as { topic?: string; text?: string };
    assert.equal(rec.topic, topic);
    assert.ok((rec.text ?? "").length > 20, topic);
  }
  const unknown = await callMcpTool("explain", { topic: "nope" }, ctx);
  assert.deepEqual(unknown.result, { error: "unknown_topic" });
});

test("open_page maps known console routes", async () => {
  assert.equal(ASSISTANT_PAGES.providers, "/providers");
  assert.equal(ASSISTANT_PAGES.keys, "/");
  const opened = await callMcpTool("open_page", { page: "playground" }, ctx);
  assert.deepEqual(opened, {
    result: { href: "/playground" },
    navigate: "/playground",
  });
  const unknown = await callMcpTool("open_page", { page: "nope" }, ctx);
  assert.deepEqual(unknown.result, { error: "unknown_page" });
});

test("list_keys mapping never selects hash or secret", async () => {
  const source = await readFile(
    new URL("../src/lib/assistant/mcp.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf('case "list_keys"');
  const end = source.indexOf('case "explain"');
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /prefix: true/);
  assert.match(block, /keyAlias: true/);
  assert.match(block, /toPublicKeyView/);
  assert.doesNotMatch(block, /\bhash\b/);
  assert.doesNotMatch(block, /secret/);
  assert.doesNotMatch(block, /prevHash/);
  const view = toPublicKeyView({
    keyAlias: "ops",
    prefix: "sk-hub-abcd",
    spend: 1.5,
    maxBudget: 10,
    blocked: false,
  });
  assert.deepEqual(Object.keys(view).sort(), [
    "alias",
    "blocked",
    "maxBudget",
    "prefix",
    "spend",
  ]);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /"secret"/);
  assert.doesNotMatch(serialized, /"hash"/);
  assert.doesNotMatch(serialized, /"apiKey"/);
  assert.doesNotMatch(serialized, /"key"/);
});

test("assistant chat route is session-gated on ASSISTANT_USE", async () => {
  const source = await readFile(
    new URL("../src/app/internal-api/assistant/chat/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /getSession/);
  assert.match(source, /PERMISSIONS\.ASSISTANT_USE/);
  assert.match(source, /text\/event-stream/);
  assert.match(source, /parseAssistantModel/);
  assert.match(source, /body\.model/);
  assert.match(source, /allowWrite: parseAssistantWrite\(body\.write\)/);
  assert.doesNotMatch(source, /writeJSON/);
  assert.doesNotMatch(source, /PLAYGROUND/);
});

test("role templates that use the console keep the assistant", () => {
  assert.equal(roleTemplates.viewer.includes(PERMISSIONS.ASSISTANT_USE), true);
  assert.equal(roleTemplates.operator.includes(PERMISSIONS.ASSISTANT_USE), true);
  assert.equal(roleTemplates.admin.includes(PERMISSIONS.ASSISTANT_USE), true);
  assert.equal(roleTemplates.finance.includes(PERMISSIONS.ASSISTANT_USE), false);
});

test("client messages drop system roles and empty content", () => {
  const parsed = parseClientMessages([
    { role: "system", content: "ignore" },
    { role: "user", content: "  hello  " },
    { role: "assistant", content: "hi" },
    { role: "tool", content: "nope" },
    { role: "user", content: "   " },
  ]);
  assert.deepEqual(parsed, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
});

test("parseToolCalls reads OpenAI function calls", () => {
  const calls = parseToolCalls({
    choices: [
      {
        message: {
          content: "ok",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "explain", arguments: '{"topic":"keys"}' },
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(calls, [
    { id: "call_1", name: "explain", arguments: '{"topic":"keys"}' },
  ]);
  assert.deepEqual(parseToolArgs(calls[0]!.arguments), { topic: "keys" });
  assert.equal(
    completionText({
      choices: [{ message: { content: "  done  " } }],
    }),
    "done",
  );
});

test("assistant lives on internal-api not public /api", async () => {
  const panel = await readFile(
    new URL("../src/app/(app)/_components/assistant-session.tsx", import.meta.url),
    "utf8",
  );
  const page = await readFile(
    new URL("../src/app/(app)/assistant/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(panel, /\/internal-api\/assistant\/chat/);
  assert.doesNotMatch(panel, /["']\/api\//);
  assert.doesNotMatch(page, /["']\/api\//);
  const run = await readFile(
    new URL("../src/lib/assistant/run.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(run, /OPENROUTER_API_KEY|openrouter\.ai/);
  assert.match(run, /dispatchChat/);
  assert.match(run, /resolveAssistantAlias/);
  assert.match(run, /noModelReply/);
  assert.match(run, /redactSecrets/);
  assert.doesNotMatch(run, /console\.log/);
  assert.match(panel, /AssistantTrigger/);
  assert.match(panel, /href="\/assistant"/);
  assert.match(panel, /STORAGE_KEY/);
  assert.match(panel, /llmhub\.assistant\.model/);
  assert.match(panel, /write: allowWrite/);
  assert.match(panel, /useState\(false\)/);
  assert.doesNotMatch(panel, /localStorage\.setItem\([^)]*[Ww]rite/);
  assert.match(page, /loadAssistantAction/);
  assert.match(page, /useAssistantSession/);
  assert.match(page, /Select\.Trigger/);
  assert.match(page, /Select\.Indicator/);
  assert.match(page, /<Switch/);
  const action = await readFile(
    new URL("../src/app/(app)/assistant/_action.ts", import.meta.url),
    "utf8",
  );
  assert.match(action, /requirePermission\(PERMISSIONS\.ASSISTANT_USE\)/);
  const nav = await readFile(
    new URL("../src/app/(app)/_components/nav-data.ts", import.meta.url),
    "utf8",
  );
  assert.match(nav, /href: "\/assistant".*PERMISSIONS\.ASSISTANT_USE/);
  const topbar = await readFile(
    new URL("../src/app/(app)/_components/console-topbar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(topbar, /AssistantTrigger/);
});

test("assistant run uses posted alias not alphabetical first ModelGroup", async () => {
  const run = await readFile(
    new URL("../src/lib/assistant/run.ts", import.meta.url),
    "utf8",
  );
  assert.match(run, /findUnique/);
  assert.doesNotMatch(run, /findFirst/);
  assert.doesNotMatch(run, /orderBy:\s*\{\s*alias:\s*"asc"/);
  assert.match(run, /assistant_model/);
  assert.match(run, /if \(!alias\) throw new AssistantNoLlmError\(\)/);
});

test("parseAssistantModel keeps gateway aliases and drops junk", () => {
  assert.equal(parseAssistantModel("openai/gpt-4o"), "openai/gpt-4o");
  assert.equal(parseAssistantModel("  claude-sonnet-4  "), "claude-sonnet-4");
  assert.equal(parseAssistantModel("bad model"), "");
  assert.equal(parseAssistantModel("../etc"), "");
  assert.equal(parseAssistantModel(""), "");
});

test("write tools wrap console actions and re-check manage perms", async () => {
  const source = await readFile(
    new URL("../src/lib/assistant/mcp.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /createProviderAction/);
  assert.match(source, /createModelGroupAction/);
  assert.match(source, /createKeyAction/);
  assert.match(source, /PROVIDERS_MANAGE/);
  assert.match(source, /MODELS_MANAGE/);
  assert.match(source, /KEYS_MANAGE/);
  assert.doesNotMatch(source, /master_key/);
});

test("system prompt names the dashboard MCP and setup loop", () => {
  const prompt = assistantSystemPrompt();
  assert.match(prompt, /get_setup_status/);
  assert.match(prompt, /get_overview/);
  assert.match(prompt, /virtual key/i);
  assert.match(prompt, /list_keys returns prefixes only/);
  assert.match(prompt, /Never ask the operator to paste a provider API key/);
  assert.match(assistantSystemPrompt("de"), /Reply in German/);
  assert.equal(parseAssistantLocale("de"), "de");
  assert.equal(parseAssistantLocale("fr"), "en");
});

test("mcpToolsForModel hides write tools without manage perms", () => {
  const viewer: AssistantContext = {
    userId: "user-2",
    permissions: [...roleTemplates.viewer],
    teamId: "",
    orgId: "",
    locale: "en",
    allowWrite: true,
  };
  const names = mcpToolsForModel(viewer).map((tool) => tool.function.name);
  assert.equal(names.includes("create_key"), false);
  assert.equal(names.includes("create_provider"), false);
  assert.equal(names.includes("create_model"), false);
  assert.equal(names.includes("explain"), true);
  assert.equal(names.includes("get_overview"), true);
  const adminNames = mcpToolsForModel(ctx).map((tool) => tool.function.name);
  assert.equal(adminNames.includes("create_key"), true);
});

test("redactSecrets strips virtual keys and provider keys before they reach the model", () => {
  const secret = "sk-hub-" + "ab".repeat(18);
  assert.equal(redactSecrets(`copy ${secret} now`).includes(secret), false);
  assert.equal(redactSecrets("use sk-proj-abcdefghijklmnop please").includes("sk-proj-abcdefghijklmnop"), false);
  assert.equal(redactSecrets("plain text stays"), "plain text stays");
});

test("consumeSseBuffer holds partial lines until flush", () => {
  const first = consumeSseBuffer('data: {"type":"text","delta":"Hi"}');
  assert.deepEqual(first.events, []);
  assert.match(first.rest, /delta/);
  const flushed = consumeSseBuffer(first.rest, true);
  assert.deepEqual(flushed.events, [{ type: "text", delta: "Hi" }]);
  const two = consumeSseBuffer(
    'data: {"type":"done"}\n\ndata: {"type":"text","delta":"x"}\n',
  );
  assert.equal(two.events.length, 2);
});

test("write tools stay hidden and refuse to run without write access", async () => {
  const readOnly: AssistantContext = { ...ctx, allowWrite: false };
  const names = mcpToolsForModel(readOnly).map((tool) => tool.function.name);
  for (const name of ["create_provider", "create_model", "create_key"]) {
    assert.equal(isWriteTool(name), true, name);
    assert.equal(names.includes(name), false, name);
    const called = await callMcpTool(name, { alias: "x", kind: "openai" }, readOnly);
    assert.deepEqual(called, { result: { error: "read_only" } }, name);
  }
  assert.equal(isWriteTool("list_keys"), false);
  assert.equal(isWriteTool("toString"), false);
  assert.equal(names.includes("list_keys"), true);
  assert.equal(names.includes("open_page"), true);
});

test("write access is opt-in per request", () => {
  assert.equal(parseAssistantWrite(true), true);
  assert.equal(parseAssistantWrite("true"), false);
  assert.equal(parseAssistantWrite(1), false);
  assert.equal(parseAssistantWrite(undefined), false);
  assert.match(assistantSystemPrompt("en"), /Read-only mode/);
  assert.match(assistantSystemPrompt("en", false), /Never claim you created anything/);
  assert.match(assistantSystemPrompt("en", true), /Write access is on/);
  assert.doesNotMatch(assistantSystemPrompt("en", true), /Read-only mode/);
});

test("transcript keeps text and tool calls in order", () => {
  let message: AssistantChatMessage = { id: "a", role: "assistant", parts: [] };
  message = applyAssistantEvent(message, { type: "text", delta: "Checking." });
  message = applyAssistantEvent(message, {
    type: "tool_call",
    id: "0-0",
    name: "list_keys",
    args: {},
  });
  message = applyAssistantEvent(message, {
    type: "tool_call",
    id: "0-1",
    name: "create_key",
    args: { alias: "ops" },
  });
  message = applyAssistantEvent(message, {
    type: "tool_result",
    id: "0-0",
    name: "list_keys",
    status: "done",
    result: [{ alias: "a" }],
  });
  message = applyAssistantEvent(message, {
    type: "tool_result",
    id: "0-1",
    name: "create_key",
    status: "done",
    result: { ok: true },
    href: "/",
  });
  message = applyAssistantEvent(message, { type: "secret", id: "0-1", value: "sk-hub-x" });
  message = applyAssistantEvent(message, { type: "text", delta: "Done." });
  assert.deepEqual(
    message.parts.map((part) => (part.type === "text" ? part.text : `${part.name}:${part.status}`)),
    ["Checking.", "list_keys:done", "create_key:done", "Done."],
  );
  const created = message.parts[2];
  assert.equal(created?.type === "tool" && created.secret, "sk-hub-x");
  assert.equal(created?.type === "tool" && created.href, "/");
  assert.equal(messageText(message), "Checking.\n\nDone.");
  assert.doesNotMatch(messageText(message), /sk-hub/);
  assert.deepEqual(
    groupAssistantParts(message).map((group) =>
      group.type === "text" ? group.text : group.tools.map((tool) => tool.id).join(","),
    ),
    ["Checking.", "0-0,0-1", "Done."],
  );
});

test("stopping marks running tools as stopped", () => {
  const running: AssistantChatMessage = {
    id: "a",
    role: "assistant",
    parts: [{ type: "tool", id: "0-0", name: "get_overview", status: "running", args: {} }],
  };
  const settled = settleAssistantMessage(running);
  assert.equal(settled.parts[0]?.type === "tool" && settled.parts[0].status, "stopped");
  const idle: AssistantChatMessage = { id: "b", role: "assistant", parts: [] };
  assert.equal(settleAssistantMessage(idle), idle);
});

test("tool previews read primitive args and error codes", () => {
  assert.equal(toolArgsPreview({ alias: "ops", teamId: "", n: 2, nested: { a: 1 } }), "ops · 2");
  assert.equal(toolArgsPreview({}), "");
  assert.equal(toolArgsPreview({ text: "x".repeat(200) }).length, 120);
  assert.equal(toolErrorCode({ error: "read_only" }), "read_only");
  assert.equal(toolErrorCode([{ error: "nope" }]), "");
  assert.equal(toolErrorCode(null), "");
});

test("assistant run streams tool calls with ids and keeps secrets out of tool content", async () => {
  const run = await readFile(
    new URL("../src/lib/assistant/run.ts", import.meta.url),
    "utf8",
  );
  assert.match(run, /type: "tool_call"/);
  assert.match(run, /type: "tool_result"/);
  assert.match(run, /type: "secret", id, value: executed\.secret/);
  assert.match(run, /assistantSystemPrompt\(opts\.ctx\.locale, opts\.ctx\.allowWrite\)/);
  const pushed = run.slice(run.indexOf('role: "tool"'));
  assert.doesNotMatch(pushed.slice(0, 200), /secret/);
});

test("wire messages carry finished tool results but never secrets or links", () => {
  const message: AssistantChatMessage = {
    id: "a",
    role: "assistant",
    parts: [
      { type: "text", text: "Checking." },
      {
        type: "tool",
        id: "0-0",
        name: "create_key",
        status: "done",
        args: { alias: "ops" },
        result: { ok: true, prefix: "sk-hub-ab" },
        href: "/",
        secret: "sk-hub-secret",
      },
      { type: "tool", id: "0-1", name: "list_keys", status: "stopped", args: {} },
      { type: "text", text: "Done." },
    ],
  };
  const wire = wireMessage(message);
  assert.deepEqual(wire, {
    role: "assistant",
    parts: [
      { type: "text", text: "Checking." },
      { type: "tool", name: "create_key", args: { alias: "ops" }, result: { ok: true, prefix: "sk-hub-ab" } },
      { type: "text", text: "Done." },
    ],
  });
  assert.doesNotMatch(JSON.stringify(wire), /sk-hub-secret|href/);
  assert.deepEqual(
    wireMessage({ id: "u", role: "user", parts: [{ type: "text", text: "hi" }] }),
    { role: "user", content: "hi" },
  );
  assert.equal(wireMessage({ id: "e", role: "assistant", parts: [] }), null);
});

test("client history replays tool results as paired tool calls", () => {
  const parsed = parseClientMessages([
    { role: "user", content: "list my keys" },
    {
      role: "assistant",
      parts: [
        { type: "text", text: "Checking." },
        { type: "tool", name: "list_keys", args: {}, result: [{ alias: "a" }, { alias: "b" }] },
        { type: "tool", name: "get_overview", args: {}, result: { spend7d: 1 } },
        { type: "tool", name: "bad name", args: {}, result: {} },
        { type: "tool", name: "explain", args: { topic: "keys" } },
        { type: "text", text: "You have two keys." },
      ],
    },
    { role: "user", content: "block the second one" },
  ]);
  assert.deepEqual(
    parsed.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "assistant", "user"],
  );
  const call = parsed[1];
  assert.equal(call?.content, "Checking.");
  assert.deepEqual(
    call?.toolCalls?.map((item) => item.name),
    ["list_keys", "get_overview"],
  );
  assert.deepEqual(
    parsed.slice(2, 4).map((message) => message.toolCallId),
    call?.toolCalls?.map((item) => item.id),
  );
  assert.equal(parsed[2]?.content, JSON.stringify([{ alias: "a" }, { alias: "b" }]));
  assert.equal(parsed[4]?.content, "You have two keys.");
  for (const id of call?.toolCalls?.map((item) => item.id) ?? []) {
    assert.match(id, /^[a-zA-Z0-9_-]+$/);
  }
});

test("replayed tool results stay within the history budget", () => {
  const big = { rows: "x".repeat(10_000) };
  const turns = Array.from({ length: 10 }, () => ({
    role: "assistant",
    parts: [
      { type: "tool", name: "list_keys", args: {}, result: big },
      { type: "text", text: "ok" },
    ],
  }));
  const parsed = parseClientMessages([...turns, { role: "user", content: "next" }]);
  const tools = parsed.filter((message) => message.role === "tool");
  assert.equal(tools.length, 10);
  const total = tools.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(total < 30_000, String(total));
  assert.match(tools.at(-1)?.content ?? "", /"truncated":true/);
  assert.equal(tools[0]?.content, JSON.stringify({ omitted: true }));
});

test("assistant run replays history tools and summarizes at the step limit", async () => {
  const run = await readFile(
    new URL("../src/lib/assistant/run.ts", import.meta.url),
    "utf8",
  );
  assert.match(run, /tool_choice: toolChoice/);
  assert.match(run, /ASSISTANT_STEP_LIMIT_NOTE/);
  assert.match(run, /"none",/);
  assert.match(run, /redactSecrets\(call\.arguments\)/);
  assert.match(ASSISTANT_STEP_LIMIT_NOTE, /Do not call tools/);
});

test("search_logs parses bounded filters and defaults to the last day", () => {
  const now = new Date("2026-10-06T12:00:00.000Z");
  const defaults = parseLogSearch({}, now);
  assert.equal(defaults.filters.from, "2026-10-05T12:00:00.000Z");
  assert.equal(defaults.filters.to, "");
  assert.equal(defaults.filters.status, "");
  assert.equal(defaults.filters.userId, "");
  assert.equal(defaults.filters.keyId, "");
  assert.equal(defaults.errorsOnly, false);
  assert.equal(defaults.limit, 15);
  const custom = parseLogSearch(
    { model: " gpt-x ", status: 502, errorsOnly: true, hours: 5000, limit: 500, userId: "other" },
    now,
  );
  assert.equal(custom.filters.model, "gpt-x");
  assert.equal(custom.filters.status, "502");
  assert.equal(custom.filters.userId, "");
  assert.equal(custom.errorsOnly, true);
  assert.equal(custom.limit, 50);
  assert.equal(custom.filters.from, new Date(now.getTime() - 744 * 3_600_000).toISOString());
  assert.equal(parseLogSearch({ status: 42 }, now).filters.status, "");
  assert.equal(parseLogSearch({ errorsOnly: "true" }, now).errorsOnly, false);
  const range = parseLogSearch({ from: "2026-10-06T05:00:00Z", to: "2026-10-06T09:00:00Z" }, now);
  assert.equal(range.filters.from, "2026-10-06T05:00:00Z");
  assert.equal(range.filters.to, "2026-10-06T09:00:00Z");
});

test("search_logs reads metadata only and never request content", async () => {
  const source = await readFile(
    new URL("../src/lib/assistant/insights.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function searchLogs");
  const end = source.indexOf("export async function usageBreakdown");
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /requestLogWhere\(query\.filters, owner\)/);
  assert.match(block, /select: \{/);
  assert.doesNotMatch(block, /content|include:|requestLogContent|\btag\b/);
  assert.match(source, /SPEND_READ_ALL/);
  const samples = errorSamples([
    { error: "upstream 502" },
    { error: "upstream 502" },
    { error: "bad key sk-proj-abcdefghijklmnopqrstuvwx" },
    { error: "" },
  ]);
  assert.deepEqual(samples[0], { message: "upstream 502", count: 2 });
  assert.equal(samples.length, 2);
  assert.doesNotMatch(JSON.stringify(samples), /sk-proj-abcdefghijklmnop/);
});

test("usage_breakdown parses groups and sorts by the chosen metric", () => {
  assert.deepEqual(parseUsageBreakdown({ groupBy: "team" }), {
    groupBy: "team",
    days: 7,
    model: "",
    sort: "spend",
    limit: 10,
  });
  assert.equal(parseUsageBreakdown({ groupBy: "toString" }).groupBy, "model");
  assert.equal(parseUsageBreakdown({ days: 0 }).days, 1);
  assert.equal(parseUsageBreakdown({ days: 9999, limit: 99 }).days, 366);
  assert.equal(parseUsageBreakdown({ limit: 99 }).limit, 25);
  assert.equal(parseUsageBreakdown({ sort: "errors" }).sort, "errors");
  const rows = [
    { name: "a", spend: 1, prompt: 0, completion: 0, requests: 10, errors: 5 },
    { name: "b", spend: 3, prompt: 0, completion: 0, requests: 2, errors: 0 },
    { name: "c", spend: 2, prompt: 0, completion: 0, requests: 30, errors: 1 },
  ];
  assert.deepEqual(sortUsageRows(rows, "spend").map((row) => row.name), ["b", "c", "a"]);
  assert.deepEqual(sortUsageRows(rows, "requests").map((row) => row.name), ["c", "a", "b"]);
  assert.deepEqual(sortUsageRows(rows, "errors").map((row) => row.name), ["a", "c", "b"]);
});

test("read-only operators keep the operations tools behind spend:read", async () => {
  const readOnly: AssistantContext = { ...ctx, permissions: [], allowWrite: false };
  const names = mcpToolsForModel(readOnly).map((tool) => tool.function.name);
  assert.equal(names.includes("search_logs"), true);
  assert.equal(names.includes("usage_breakdown"), true);
  for (const name of ["search_logs", "usage_breakdown"]) {
    assert.equal(isWriteTool(name), false, name);
    const called = await callMcpTool(name, { groupBy: "model" }, readOnly);
    assert.deepEqual(called, { result: { error: "forbidden" } }, name);
  }
});
