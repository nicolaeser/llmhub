import assert from "node:assert/strict";
import test from "node:test";
import { stepBody } from "@/lib/mcp/chat-loop";
import { hubToolsInstruction } from "@/lib/mcp/instruction";
import { messagesStepBody } from "@/lib/mcp/messages-loop";
import { HUB_TOOL_PREFIX, bindTools, isMcpToolName } from "@/lib/mcp/tool-names";
import type { JsonMap } from "@/types/gateway";
import type { McpToolset } from "@/types/mcp";

const tools = bindTools(
  [
    {
      serverId: "s1",
      serverName: "crm",
      tools: [
        { name: "contacts_search", title: "", description: "", inputSchema: { type: "object" } },
        { name: "update_contact", title: "", description: "", inputSchema: { type: "object" } },
      ],
    },
  ],
  ["mcp__crm__contacts_search"],
  HUB_TOOL_PREFIX,
);

const toolset: McpToolset = {
  tools,
  byName: new Map(tools.map((bound) => [bound.name, bound])),
  executor: { call: async () => ({ text: "", isError: false }), timeoutMs: () => 30_000, close: async () => undefined },
};

const instruction = hubToolsInstruction(toolset);

test("gateway tools get their own prefix, apart from the client's mcp__ tools", () => {
  assert.deepEqual(
    tools.map((bound) => bound.name),
    ["hub__crm__contacts_search", "hub__crm__update_contact"],
  );
  assert.ok(isMcpToolName("hub__crm__contacts_search"));
  assert.ok(isMcpToolName("mcp__crm__contacts_search"));
  assert.match(instruction, /crm \(2\)/);
  assert.match(instruction, /hub__<server>__<tool>/);
});

test("chat steps carry the gateway tool instruction once and drop it with the tools on the last step", () => {
  const base: JsonMap = {
    model: "m",
    messages: [
      { role: "system", content: "You are the app." },
      { role: "user", content: "Show my open deals" },
    ],
    tools: [{ type: "function", function: { name: tools[0]!.name } }, { type: "function", function: { name: "Read" } }],
  };
  const first = stepBody(base, [], 0, false, toolset);
  const leading = (first.messages as JsonMap[])[0]!;
  assert.equal(leading.content, `You are the app.\n\n${instruction}`);
  const again = stepBody(first, [], 1, false, toolset);
  assert.equal((again.messages as JsonMap[])[0]!.content, leading.content);
  const last = stepBody(base, [], 7, true, toolset);
  assert.equal((last.messages as JsonMap[])[0]!.content, "You are the app.");
  assert.deepEqual(last.tools, [{ type: "function", function: { name: "Read" } }]);
});

test("chat steps without a system message get one", () => {
  const first = stepBody({ model: "m", messages: [{ role: "user", content: "hi" }] }, [], 0, false, toolset);
  assert.deepEqual((first.messages as JsonMap[])[0], { role: "system", content: instruction });
});

test("messages steps append the instruction after the client's system blocks", () => {
  const cached = { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } };
  const first = messagesStepBody({ model: "m", system: [cached], messages: [] }, [], 0, false, toolset);
  assert.deepEqual(first.system, [cached, { type: "text", text: instruction }]);
  const plain = messagesStepBody({ model: "m", system: "Be brief.", messages: [] }, [], 0, false, toolset);
  assert.equal(plain.system, `Be brief.\n\n${instruction}`);
  const last = messagesStepBody({ model: "m", system: [cached], messages: [] }, [], 7, true, toolset);
  assert.deepEqual(last.system, [cached]);
});
