import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicSseTranslator,
  anthropicToChat,
  chatToAnthropic,
  claudeVersion,
  parseDataUrl,
} from "@/lib/gateway/anthropic";
import type { JsonMap } from "@/types/gateway";

function translate(lines: string[]): JsonMap[] {
  const translator = new AnthropicSseTranslator("alias");
  const out: string[] = [];
  for (const line of lines) out.push(...translator.pushLine(line));
  const tail = translator.flush();
  if (tail) out.push(tail);
  return out.map((payload) => JSON.parse(payload) as JsonMap);
}

function sse(event: string, data: JsonMap): string[] {
  return [`event: ${event}`, `data: ${JSON.stringify(data)}`, ""];
}

test("chatToAnthropic keeps system prompts and simple turns", () => {
  const out = chatToAnthropic({
    model: "claude",
    messages: [
      { role: "system", content: "be brief" },
      { role: "developer", content: [{ type: "text", text: "and kind" }] },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(out.system, "be brief\nand kind");
  assert.deepEqual(out.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  assert.equal(out.max_tokens, 4096);
  assert.equal(out.model, "claude");
});

test("chatToAnthropic accepts system arrays and keeps cache_control blocks", () => {
  const plain = chatToAnthropic({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }], messages: [] });
  assert.equal(plain.system, "a\nb");
  const cached = chatToAnthropic({
    system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "system", content: "b" }],
  });
  assert.deepEqual(cached.system, [
    { type: "text", text: "a", cache_control: { type: "ephemeral" } },
    { type: "text", text: "b" },
  ]);
});

test("chatToAnthropic maps sampling parameters, stop and stream", () => {
  const out = chatToAnthropic({
    messages: [{ role: "user", content: "x" }],
    max_completion_tokens: 77,
    temperature: 1.6,
    top_p: 0.4,
    top_k: 5,
    stop: "END",
    stream: true,
    user: "u-1",
  });
  assert.equal(out.max_tokens, 77);
  assert.equal(out.temperature, 1);
  assert.equal(out.top_p, undefined);
  assert.equal(out.top_k, 5);
  assert.deepEqual(out.stop_sequences, ["END"]);
  assert.equal(out.stream, true);
  assert.deepEqual(out.metadata, { user_id: "u-1" });
  const topP = chatToAnthropic({ messages: [], max_tokens: 9, top_p: 0.5, stop: ["a", "b"] });
  assert.equal(topP.max_tokens, 9);
  assert.equal(topP.top_p, 0.5);
  assert.deepEqual(topP.stop_sequences, ["a", "b"]);
  assert.equal("stream_options" in chatToAnthropic({ messages: [], stream_options: { include_usage: true } }), false);
});

test("chatToAnthropic maps tools and every tool_choice form", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Weather lookup",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
  ];
  const base = { messages: [{ role: "user", content: "x" }], tools };
  const auto = chatToAnthropic({ ...base, tool_choice: "auto" });
  assert.deepEqual(auto.tools, [
    {
      name: "get_weather",
      description: "Weather lookup",
      input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  ]);
  assert.deepEqual(auto.tool_choice, { type: "auto" });
  assert.deepEqual(chatToAnthropic({ ...base, tool_choice: "none" }).tool_choice, { type: "none" });
  assert.deepEqual(chatToAnthropic({ ...base, tool_choice: "required" }).tool_choice, { type: "any" });
  assert.deepEqual(
    chatToAnthropic({ ...base, tool_choice: { type: "function", function: { name: "get_weather" } } }).tool_choice,
    { type: "tool", name: "get_weather" },
  );
  assert.deepEqual(chatToAnthropic({ ...base, parallel_tool_calls: false }).tool_choice, {
    type: "auto",
    disable_parallel_tool_use: true,
  });
  const noTools = chatToAnthropic({ messages: [], tool_choice: "required" });
  assert.equal(noTools.tools, undefined);
  assert.equal(noTools.tool_choice, undefined);
});

test("chatToAnthropic converts tool calls and merges tool results into one user turn", () => {
  const out = chatToAnthropic({
    messages: [
      { role: "user", content: "weather in paris and rome?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
          { id: "call_2", type: "function", function: { name: "get_weather", arguments: '{"city":"Rome"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
      { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "rainy" }] },
      { role: "user", content: "thanks" },
    ],
  });
  const messages = out.messages as JsonMap[];
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: [
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
      { type: "tool_use", id: "call_2", name: "get_weather", input: { city: "Rome" } },
    ],
  });
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_1", content: "sunny" },
      { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "rainy" }] },
      { type: "text", text: "thanks" },
    ],
  });
  const empty = chatToAnthropic({ messages: [{ role: "tool", tool_call_id: "call_3", content: "" }] });
  assert.deepEqual((empty.messages as JsonMap[])[0]?.content, [{ type: "tool_result", tool_use_id: "call_3" }]);
});

test("chatToAnthropic converts data URL and http image parts", () => {
  const out = chatToAnthropic({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "compare" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          { type: "image_url", image_url: "https://example.com/cat.jpg" },
          { type: "image_url", image_url: { url: "ftp://nope" } },
        ],
      },
    ],
  });
  assert.deepEqual((out.messages as JsonMap[])[0]?.content, [
    { type: "text", text: "compare" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    { type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } },
  ]);
  assert.deepEqual(parseDataUrl("data:image/jpeg;charset=x;base64,QUJD"), { mediaType: "image/jpeg", data: "QUJD" });
  assert.equal(parseDataUrl("data:text/plain,hello"), null);
});

test("anthropicToChat maps text, tool_use, stop reasons, and usage", () => {
  const back = anthropicToChat(
    {
      id: "msg_1",
      type: "message",
      content: [
        { type: "text", text: "hello from claude" },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 8, output_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 },
    },
    "claude-sonnet",
  );
  const choice = (back.choices as JsonMap[])[0]!;
  assert.equal(back.object, "chat.completion");
  assert.equal(back.model, "claude-sonnet");
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(choice.message, {
    role: "assistant",
    content: "hello from claude",
    tool_calls: [
      { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
    ],
  });
  assert.deepEqual(back.usage, {
    prompt_tokens: 20,
    completion_tokens: 4,
    total_tokens: 24,
    prompt_tokens_details: { cached_tokens: 10 },
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 2,
  });
  const reasons: [string, string][] = [
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "tool_calls"],
  ];
  for (const [stop, finish] of reasons) {
    const out = anthropicToChat({ content: [{ type: "text", text: "x" }], stop_reason: stop }, "m");
    assert.equal((out.choices as JsonMap[])[0]?.finish_reason, finish);
  }
  const seq = anthropicToChat({ content: [], stop_reason: "stop_sequence", stop_sequence: "END" }, "m");
  assert.equal((seq.choices as JsonMap[])[0]?.stop_reason, "END");
  const onlyTools = anthropicToChat(
    { content: [{ type: "tool_use", id: "t", name: "n", input: {} }], stop_reason: "tool_use" },
    "m",
  );
  assert.equal(((onlyTools.choices as JsonMap[])[0]?.message as JsonMap).content, null);
});

test("AnthropicSseTranslator streams text, tool call deltas, and final usage", () => {
  const chunks = translate([
    ...sse("message_start", {
      type: "message_start",
      message: { id: "msg_9", usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 3 } },
    }),
    ...sse("ping", { type: "ping" }),
    ...sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ...sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
    ...sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
    ...sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    ...sse("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
    }),
    ...sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "" },
    }),
    ...sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":' },
    }),
    ...sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"Paris"}' },
    }),
    ...sse("content_block_stop", { type: "content_block_stop", index: 1 }),
    ...sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 30 },
    }),
    ...sse("message_stop", { type: "message_stop" }),
  ]);
  const deltas = chunks.map((chunk) => (chunk.choices as JsonMap[])[0]?.delta as JsonMap);
  assert.ok(chunks.every((chunk) => chunk.object === "chat.completion.chunk" && chunk.id === "msg_9"));
  assert.deepEqual(deltas[0], { role: "assistant", content: "" });
  assert.equal(deltas[1]?.content, "Hel");
  assert.equal(deltas[2]?.content, "lo");
  assert.deepEqual(deltas[3]?.tool_calls, [
    { index: 0, id: "toolu_1", type: "function", function: { name: "get_weather", arguments: "" } },
  ]);
  assert.deepEqual(deltas[4]?.tool_calls, [{ index: 0, function: { arguments: '{"city":' } }]);
  assert.deepEqual(deltas[5]?.tool_calls, [{ index: 0, function: { arguments: '"Paris"}' } }]);
  const last = chunks.at(-1)!;
  assert.equal((last.choices as JsonMap[])[0]?.finish_reason, "tool_calls");
  assert.deepEqual(last.usage, {
    prompt_tokens: 15,
    completion_tokens: 30,
    total_tokens: 45,
    prompt_tokens_details: { cached_tokens: 3 },
    cache_read_input_tokens: 3,
  });
  assert.equal(chunks.length, 7);
});

test("AnthropicSseTranslator flushes events without blank separators and surfaces errors", () => {
  const translator = new AnthropicSseTranslator("alias");
  const out: string[] = [];
  out.push(...translator.pushLine("event: content_block_delta"));
  out.push(
    ...translator.pushLine(
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } })}\r`,
    ),
  );
  out.push(...translator.pushLine("event: message_delta"));
  out.push(
    ...translator.pushLine(
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 2 } })}`,
    ),
  );
  const tail = translator.flush();
  if (tail) out.push(tail);
  assert.equal(out.length, 2);
  assert.equal(((JSON.parse(out[1]!) as JsonMap).choices as JsonMap[])[0]?.finish_reason, "length");
  const failing = new AnthropicSseTranslator("alias");
  failing.pushLine("event: error");
  failing.pushLine(`data: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}`);
  assert.throws(() => failing.pushLine(""), /Overloaded/);
});

test("claudeVersion reads dated, aliased, and dotted Claude ids", () => {
  assert.equal(claudeVersion("claude-3-7-sonnet-20250219"), 3.7);
  assert.equal(claudeVersion("claude-sonnet-4-20250514"), 4);
  assert.equal(claudeVersion("claude-sonnet-4-5-20250929"), 4.5);
  assert.equal(claudeVersion("claude-opus-4-6"), 4.6);
  assert.equal(claudeVersion("claude-opus-5-5"), 5.5);
  assert.equal(claudeVersion("claude-sonnet-4.5"), 4.5);
  assert.equal(claudeVersion("claude-mythos-preview"), null);
  assert.equal(claudeVersion("gpt-6-sol"), null);
});

test("reasoning_effort maps to adaptive thinking and effort on current Claude models", () => {
  const out = chatToAnthropic({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "x" }],
    reasoning_effort: "high",
    temperature: 0.2,
    top_p: 0.5,
  });
  assert.deepEqual(out.thinking, { type: "adaptive" });
  assert.deepEqual(out.output_config, { effort: "high" });
  assert.equal(out.temperature, undefined);
  assert.equal(out.top_p, undefined);
  assert.equal(out.max_tokens, 4096);
  const minimal = chatToAnthropic({ model: "claude-sonnet-4-6", messages: [], reasoning_effort: "minimal" });
  assert.deepEqual(minimal.output_config, { effort: "low" });
  const none = chatToAnthropic({ model: "claude-sonnet-4-6", messages: [], reasoning_effort: "none", temperature: 0.3 });
  assert.equal(none.thinking, undefined);
  assert.deepEqual(none.output_config, { effort: "low" });
  assert.equal(none.temperature, 0.3);
});

test("reasoning_effort maps to budget thinking on Claude 4.5 and earlier", () => {
  const open = chatToAnthropic({
    model: "claude-sonnet-4-5-20250929",
    messages: [],
    reasoning_effort: "high",
    temperature: 0.7,
    top_p: 0.97,
    top_k: 5,
  });
  assert.deepEqual(open.thinking, { type: "enabled", budget_tokens: 4096 });
  assert.equal(open.max_tokens, 8192);
  assert.equal(open.output_config, undefined);
  assert.equal(open.temperature, undefined);
  assert.equal(open.top_k, undefined);
  assert.equal(open.top_p, 0.97);
  const capped = chatToAnthropic({ model: "claude-haiku-4-5", messages: [], reasoning_effort: "max", max_tokens: 3000 });
  assert.deepEqual(capped.thinking, { type: "enabled", budget_tokens: 2999 });
  assert.equal(capped.max_tokens, 3000);
  const tiny = chatToAnthropic({ model: "claude-haiku-4-5", messages: [], reasoning_effort: "low", max_tokens: 900, temperature: 0.1 });
  assert.equal(tiny.thinking, undefined);
  assert.equal(tiny.temperature, 0.1);
});

test("native thinking, output_config, structured outputs, and strict tools pass to Anthropic", () => {
  const out = chatToAnthropic({
    model: "claude-opus-5-5",
    messages: [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "ignored display copy",
        thinking_blocks: [
          { type: "thinking", thinking: "plan", signature: "sig-1" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "thinking", thinking: "no signature" },
        ],
        tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "r" },
    ],
    thinking: { type: "adaptive", display: "summarized" },
    reasoning_effort: "low",
    output_config: { effort: "max" },
    response_format: { type: "json_schema", json_schema: { name: "o", schema: { type: "object" }, strict: true } },
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" }, strict: true } }],
  });
  assert.deepEqual(out.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(out.output_config, { effort: "max", format: { type: "json_schema", schema: { type: "object" } } });
  assert.equal((out.tools as JsonMap[])[0]!.strict, true);
  const assistant = (out.messages as JsonMap[])[1]!;
  assert.deepEqual(assistant.content, [
    { type: "thinking", thinking: "plan", signature: "sig-1" },
    { type: "redacted_thinking", data: "opaque" },
    { type: "tool_use", id: "call_1", name: "f", input: {} },
  ]);
  const legacyFormat = chatToAnthropic({
    model: "claude-opus-4-6",
    messages: [],
    response_format: { type: "json_object" },
    temperature: 0.4,
  });
  assert.equal(legacyFormat.output_config, undefined);
  assert.equal(legacyFormat.temperature, 0.4);
});

test("anthropicToChat surfaces thinking as reasoning_content and signed thinking_blocks", () => {
  const out = anthropicToChat(
    {
      content: [
        { type: "thinking", thinking: "step 1", signature: "sig" },
        { type: "redacted_thinking", data: "blob" },
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 4,
        output_tokens: 30,
        cache_creation_input_tokens: 6,
        cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 },
        output_tokens_details: { thinking_tokens: 20 },
      },
    },
    "alias",
  );
  const message = (out.choices as JsonMap[])[0]!.message as JsonMap;
  assert.equal(message.content, "answer");
  assert.equal(message.reasoning_content, "step 1");
  assert.deepEqual(message.thinking_blocks, [
    { type: "thinking", thinking: "step 1", signature: "sig" },
    { type: "redacted_thinking", data: "blob" },
  ]);
  const usage = out.usage as JsonMap;
  assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 20 });
  assert.equal(usage.prompt_tokens, 10);
  assert.deepEqual(usage.cache_creation, { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 });
});

test("AnthropicSseTranslator streams thinking deltas and a signed thinking block", () => {
  const chunks = translate([
    ...sse("message_start", { type: "message_start", message: { id: "msg_t", usage: { input_tokens: 3 } } }),
    ...sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    ...sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "a" } }),
    ...sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "b" } }),
    ...sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
    ...sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    ...sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "x" } }),
    ...sse("content_block_stop", { type: "content_block_stop", index: 1 }),
    ...sse("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }),
    ...sse("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "hi" } }),
  ]);
  const deltas = chunks.map((chunk) => (chunk.choices as JsonMap[])[0]!.delta as JsonMap);
  assert.deepEqual(deltas[1], { reasoning_content: "a" });
  assert.deepEqual(deltas[2], { reasoning_content: "b" });
  assert.deepEqual(deltas[3], { thinking_blocks: [{ type: "thinking", thinking: "ab", signature: "sig" }] });
  assert.deepEqual(deltas[4], { thinking_blocks: [{ type: "redacted_thinking", data: "x" }] });
  assert.deepEqual(deltas[5], { content: "hi" });
});
