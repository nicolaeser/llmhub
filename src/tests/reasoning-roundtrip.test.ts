import assert from "node:assert/strict";
import test from "node:test";
import { chatToAnthropic, nativeMessagesBody, withCacheBreakpoints } from "@/lib/gateway/protocols/anthropic";
import { pipeChatStream } from "@/lib/gateway/protocols/chat-stream";
import {
  chatIncompatibility,
  chatToMessage,
  claudeCodeSession,
  messagesToChat,
  MessagesStreamEncoder,
} from "@/lib/gateway/protocols/messages";
import { parseRequest } from "@/lib/gateway/protocols/parse-request";
import { responsesToChat } from "@/lib/gateway/protocols/responses";
import { chatToCodex, codexCompletion, CodexSseTranslator } from "@/lib/gateway/upstreams/codex";
import { messagesRequestSchema } from "@/schemas/anthropic";
import { responsesRequestSchema } from "@/schemas/responses";
import type { JsonMap } from "@/types/gateway";

const CODEX_SIG = "gAAAAABcodex-encrypted-reasoning";

function sse(events: JsonMap[]): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function translate(text: string): JsonMap[] {
  const translator = new CodexSseTranslator("gpt-5.6-terra");
  const out: JsonMap[] = [];
  for (const line of text.split("\n")) for (const payload of translator.pushLine(line)) out.push(JSON.parse(payload));
  const rest = translator.flush();
  if (rest) out.push(JSON.parse(rest));
  return out;
}

const REASONING_EVENTS: JsonMap[] = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
  { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Plan" },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Plan" }], encrypted_content: CODEX_SIG },
  },
  { type: "response.output_text.delta", output_index: 1, delta: "Done" },
  { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 3 } } },
];

test("codex requests ask for encrypted reasoning and replay codex-signed thinking as reasoning items", () => {
  const payload = chatToCodex({
    model: "gpt-5.6-terra",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
        thinking_blocks: [
          { type: "thinking", thinking: "Plan", signature: CODEX_SIG },
          { type: "thinking", thinking: "claude", signature: "EqQBclaude-signature" },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "found" },
    ],
  });
  assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
  const types = (payload.input as JsonMap[]).map((item) => item.type);
  assert.deepEqual(types, ["message", "reasoning", "message", "function_call", "function_call_output"]);
  assert.deepEqual((payload.input as JsonMap[])[1], { type: "reasoning", summary: [], encrypted_content: CODEX_SIG });
});

test("codex reasoning items stream back as a signed thinking block", () => {
  const chunks = translate(sse(REASONING_EVENTS));
  const signed = chunks.find((chunk) => {
    const delta = ((chunk.choices as JsonMap[])[0]?.delta ?? {}) as JsonMap;
    return Array.isArray(delta.thinking_blocks);
  });
  assert.ok(signed);
  const delta = (signed.choices as JsonMap[])[0]!.delta as JsonMap;
  assert.deepEqual(delta.thinking_blocks, [{ type: "thinking", thinking: "Plan", signature: CODEX_SIG }]);
  const completion = codexCompletion(sse(REASONING_EVENTS), "gpt-5.6-terra");
  const message = (completion.choices as JsonMap[])[0]!.message as JsonMap;
  assert.deepEqual(message.thinking_blocks, [{ type: "thinking", thinking: "Plan", signature: CODEX_SIG }]);
  const anthropic = chatToMessage(completion, "gpt-5.6-terra");
  assert.deepEqual((anthropic.content as JsonMap[])[0], { type: "thinking", thinking: "Plan", signature: CODEX_SIG });
});

test("the Anthropic stream carries the codex signature in its signature_delta", async () => {
  const chunks = translate(sse(REASONING_EVENTS));
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  const res = pipeChatStream(new Response(body), new MessagesStreamEncoder("gpt-5.6-terra"));
  const text = await res.text();
  assert.match(text, /"thinking":"Plan"/);
  assert.match(text, new RegExp(`"signature_delta","signature":"${CODEX_SIG}"`));
  assert.equal((text.match(/"type":"thinking"/g) ?? []).length, 1);
});

test("Claude Code history keeps signed thinking for codex and drops foreign thinking for Claude", () => {
  const parsed = parseRequest(messagesRequestSchema, {
    model: "m",
    max_tokens: 100,
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Plan", signature: CODEX_SIG },
          { type: "thinking", thinking: "unsigned", signature: "" },
          { type: "text", text: "ok" },
        ],
      },
      { role: "user", content: "next" },
    ],
  });
  assert.ok(parsed.ok);
  const chat = messagesToChat(parsed.data);
  const assistant = (chat.messages as JsonMap[])[1]!;
  assert.deepEqual(assistant.thinking_blocks, [{ type: "thinking", thinking: "Plan", signature: CODEX_SIG }]);
  const native = nativeMessagesBody(parsed.data as unknown as JsonMap);
  assert.deepEqual(((native.messages as JsonMap[])[1]!.content as JsonMap[]).map((block) => block.type), ["text"]);
  const claude = chatToAnthropic({ model: "claude-sonnet-4-6", messages: chat.messages });
  const blocks = ((claude.messages as JsonMap[])[1]!.content as JsonMap[]).map((block) => block.type);
  assert.deepEqual(blocks, ["text"]);
});

test("Codex CLI reasoning items with raw encrypted content reach the codex upstream again", () => {
  const parsed = parseRequest(responsesRequestSchema, {
    model: "gpt-5.6-terra",
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "Plan" }], encrypted_content: CODEX_SIG },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "found" },
    ],
  });
  assert.ok(parsed.ok);
  const { body } = responsesToChat(parsed.data, []);
  const codex = chatToCodex(body);
  const reasoning = (codex.input as JsonMap[]).find((item) => item.type === "reasoning");
  assert.deepEqual(reasoning, { type: "reasoning", summary: [], encrypted_content: CODEX_SIG });
});

test("converted streams send a keep-alive while the upstream is quiet", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await gate;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "late" } }] })}\n\n`));
      controller.close();
    },
  });
  const res = pipeChatStream(new Response(upstream), new MessagesStreamEncoder("m"), undefined, { keepAliveMs: 20 });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: ping")) {
    const { value } = await reader.read();
    text += decoder.decode(value);
  }
  assert.match(text, /^event: message_start/);
  release();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  assert.match(text, /"text":"late"/);
  assert.match(text, /event: message_stop/);
});

test("converted requests to a Claude subscription get prompt cache breakpoints unless the client set its own", () => {
  const marked = withCacheBreakpoints(
    chatToAnthropic({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
      tools: [
        { type: "function", function: { name: "a", parameters: { type: "object" } } },
        { type: "function", function: { name: "b", parameters: { type: "object" } } },
      ],
    }),
  );
  assert.deepEqual(marked.system, [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }]);
  const tools = marked.tools as JsonMap[];
  assert.equal(tools[0]!.cache_control, undefined);
  assert.deepEqual(tools[1]!.cache_control, { type: "ephemeral" });
  const messages = marked.messages as JsonMap[];
  assert.equal(((messages[0]!.content as JsonMap[])[0] as JsonMap).cache_control, undefined);
  assert.deepEqual(((messages[2]!.content as JsonMap[]).at(-1) as JsonMap).cache_control, { type: "ephemeral" });
  const own = {
    model: "claude-sonnet-4-6",
    system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
  };
  assert.equal(withCacheBreakpoints(own), own);
});

const SEARCH_EVENTS: JsonMap[] = [
  { type: "response.created", response: { id: "resp_2" } },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "hub release", sources: [{ type: "url", url: "https://example.com/a", title: "A" }] },
    },
  },
  { type: "response.output_text.delta", output_index: 1, delta: "Found it" },
  { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 3 } } },
];

test("Claude Code web search runs as the Codex hosted web_search tool", () => {
  const request = parseRequest(messagesRequestSchema, {
    model: "m",
    max_tokens: 100,
    messages: [
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_old", name: "web_search", input: { query: "old" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_old", content: [] },
          { type: "text", text: "earlier" },
        ],
      },
      { role: "user", content: "again" },
    ],
    tools: [
      { type: "web_search_20250305", name: "web_search", max_uses: 5, allowed_domains: ["example.com"] },
      { name: "Bash", input_schema: { type: "object", properties: {} } },
    ],
    tool_choice: { type: "tool", name: "web_search" },
  });
  assert.ok(request.ok);
  assert.match(chatIncompatibility(request.data) ?? "", /web_search_20250305/);
  assert.equal(chatIncompatibility(request.data, { webSearch: true }), null);
  const chat = messagesToChat(request.data);
  assert.deepEqual(chat.web_search, { allowed_domains: ["example.com"], forced: true });
  assert.equal((chat.tools as JsonMap[]).length, 1);
  assert.equal(chat.tool_choice, undefined);
  const codex = chatToCodex(chat);
  assert.deepEqual((codex.tools as JsonMap[]).at(-1), { type: "web_search", filters: { allowed_domains: ["example.com"] } });
  assert.deepEqual(codex.tool_choice, { type: "web_search" });
  assert.deepEqual(codex.include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
  const assistantText = (codex.input as JsonMap[]).find((item) => item.role === "assistant");
  assert.deepEqual(assistantText?.content, [{ type: "output_text", text: "earlier" }]);
});

test("Codex web searches stream back as server_tool_use and web_search_tool_result blocks", async () => {
  const chunks = translate(sse(SEARCH_EVENTS));
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  const text = await pipeChatStream(new Response(body), new MessagesStreamEncoder("gpt-5.6-terra")).text();
  assert.match(text, /"type":"server_tool_use","id":"srvtoolu_ws_1","name":"web_search"/);
  assert.match(text, /"partial_json":"{\\"query\\":\\"hub release\\"}"/);
  assert.match(text, /"type":"web_search_tool_result","tool_use_id":"srvtoolu_ws_1"/);
  assert.match(text, /"url":"https:\/\/example.com\/a","title":"A"/);
  assert.match(text, /"server_tool_use":{"web_search_requests":1}/);
  assert.match(text, /"stop_reason":"end_turn"/);
  const message = chatToMessage(codexCompletion(sse(SEARCH_EVENTS), "gpt-5.6-terra"), "gpt-5.6-terra");
  assert.deepEqual(
    (message.content as JsonMap[]).map((block) => block.type),
    ["server_tool_use", "web_search_tool_result", "text"],
  );
  const native = nativeMessagesBody({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: [...(message.content as JsonMap[])] },
    ],
  });
  assert.deepEqual(((native.messages as JsonMap[])[1]!.content as JsonMap[]).map((block) => block.type), ["text"]);
});

test("Claude Code sessions become a stable prompt cache key for Codex", () => {
  assert.equal(claudeCodeSession("user_abc_account_123_session_0f6e2c1a-1111-2222-3333-444455556666"), "0f6e2c1a-1111-2222-3333-444455556666");
  assert.equal(claudeCodeSession(JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "s-1" })), "s-1");
  assert.equal(claudeCodeSession("plain-user"), "");
  const parsed = parseRequest(messagesRequestSchema, {
    model: "m",
    max_tokens: 10,
    metadata: { user_id: JSON.stringify({ session_id: "s-1" }) },
    messages: [{ role: "user", content: "hi" }],
  });
  assert.ok(parsed.ok);
  const codex = chatToCodex(messagesToChat(parsed.data));
  assert.equal(codex.prompt_cache_key, "claude-code-s-1");
});
