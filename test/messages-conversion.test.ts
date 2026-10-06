import assert from "node:assert/strict";
import test from "node:test";
import { anthropicErrorBody } from "@/lib/gateway/errors";
import {
  anthropicPassthroughHeaders,
  apiKeyRequest,
  chatIncompatibility,
  chatToMessage,
  messagesToChat,
  MessagesStreamEncoder,
} from "@/lib/gateway/messages";
import { parseRequest, pipeChatStream } from "@/lib/gateway/responses";
import { messagesRequestSchema } from "@/schemas/anthropic";
import type { MessagesRequest } from "@/types/anthropic";
import type { JsonMap } from "@/types/gateway";

function parse(body: JsonMap): MessagesRequest {
  const parsed = parseRequest(messagesRequestSchema, body);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.data;
}

function chatSse(chunks: (JsonMap | string)[]): Response {
  const text = chunks
    .map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`)
    .join("");
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function chunk(delta: JsonMap, finish: string | null = null, extra: JsonMap = {}): JsonMap {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "alias",
    choices: [{ index: 0, delta, finish_reason: finish, ...extra }],
  };
}

async function anthropicEvents(res: Response): Promise<{ event: string; data: JsonMap }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = JSON.parse(lines.find((line) => line.startsWith("data: "))!.slice(6)) as JsonMap;
      assert.equal(data.type, event);
      return { event, data };
    });
}

test("messages request converts to an OpenAI chat body", () => {
  const body = messagesToChat(
    parse({
      model: "claude-alias",
      system: [{ type: "text", text: "be brief" }, { type: "text", text: "be kind" }],
      max_tokens: 256,
      temperature: 0.3,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ["END"],
      metadata: { user_id: "user-7" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
            { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "sig" },
            { type: "text", text: "checking" },
            { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "a" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "found it" },
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "WFla" } },
              ],
            },
            { type: "text", text: "continue" },
          ],
        },
      ],
      tools: [{ name: "lookup", description: "Look up", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    }),
  );
  assert.deepEqual(body.messages, [
    { role: "system", content: "be brief\nbe kind" },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    },
    {
      role: "assistant",
      content: "checking",
      tool_calls: [{ id: "toolu_1", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } }],
    },
    { role: "tool", tool_call_id: "toolu_1", content: "found it" },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,WFla" } },
        { type: "text", text: "continue" },
      ],
    },
  ]);
  assert.equal(body.max_tokens, 256);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.top_p, 0.9);
  assert.equal("top_k" in body, false);
  assert.deepEqual(body.stop, ["END"]);
  assert.equal(body.user, "user-7");
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: { name: "lookup", description: "Look up", parameters: { type: "object", properties: {} } },
    },
  ]);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.stream, undefined);
  assert.equal(body.stream_options, undefined);
});

test("messages tool_choice variants and streaming flags map to chat", () => {
  const base = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "t", input_schema: { type: "object" } }],
  };
  assert.equal(messagesToChat(parse({ ...base, tool_choice: { type: "auto" } })).tool_choice, "auto");
  assert.equal(messagesToChat(parse({ ...base, tool_choice: { type: "none" } })).tool_choice, "none");
  assert.deepEqual(messagesToChat(parse({ ...base, tool_choice: { type: "tool", name: "t" } })).tool_choice, {
    type: "function",
    function: { name: "t" },
  });
  const streamed = messagesToChat(parse({ ...base, stream: true, system: "sys" }));
  assert.equal(streamed.stream, true);
  assert.deepEqual(streamed.stream_options, { include_usage: true });
  assert.deepEqual((streamed.messages as JsonMap[])[0], { role: "system", content: "sys" });
  assert.deepEqual((streamed.messages as JsonMap[])[1], { role: "user", content: "hi" });
});

test("messages schema rejects malformed requests", () => {
  const bad = [
    { model: "m", messages: [] },
    { model: "m", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64" } }] }] },
    { model: "m", messages: [{ role: "user", content: [{ type: "mystery" }] }] },
    { model: "m", messages: [{ role: "user", content: "x" }], temperature: 3 },
    { model: "m", messages: [{ role: "user", content: "x" }], tools: [{ input_schema: { type: "object" } }] },
  ];
  for (const body of bad) {
    const parsed = parseRequest(messagesRequestSchema, body);
    assert.equal(parsed.ok, false, JSON.stringify(body));
  }
  const image = parseRequest(messagesRequestSchema, bad[1]);
  if (!image.ok) assert.match(image.message, /^messages\.0\.content\.0\.source\.media_type/);
});

test("native-only Messages features pass the schema but block the chat fallback", () => {
  const server = parse({
    model: "m",
    messages: [{ role: "user", content: "x" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });
  assert.match(chatIncompatibility(server) ?? "", /^tools\.0\.type: tool type "web_search_20250305" requires an Anthropic deployment/);
  const blocks = parse({
    model: "m",
    messages: [
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
        ],
      },
    ],
  });
  assert.match(chatIncompatibility(blocks) ?? "", /^messages\.1\.content\.0\.type: content block "server_tool_use"/);
  const fileImage = parse({
    model: "m",
    messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "file_1" } }] }],
  });
  assert.match(chatIncompatibility(fileImage) ?? "", /image source "file" requires an Anthropic deployment/);
  const plain = parse({
    model: "m",
    messages: [
      { role: "user", content: [{ type: "document", source: { type: "text", data: "notes" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "ok" }] },
      { role: "system", content: "be brief" },
      { role: "user", content: "next" },
    ],
  });
  assert.equal(chatIncompatibility(plain), null);
  assert.deepEqual(messagesToChat(plain).messages, [
    { role: "user", content: "notes" },
    { role: "assistant", content: "ok" },
    { role: "system", content: "be brief" },
    { role: "user", content: "next" },
  ]);
});

test("thinking, effort, structured output, and strict tools map to chat parameters", () => {
  const budget = messagesToChat(
    parse({
      model: "m",
      max_tokens: 9000,
      messages: [{ role: "user", content: "x" }],
      thinking: { type: "enabled", budget_tokens: 4000 },
      tools: [{ name: "t", input_schema: { type: "object" }, strict: true }],
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    }),
  );
  assert.equal(budget.reasoning_effort, "medium");
  assert.deepEqual(budget.response_format, {
    type: "json_schema",
    json_schema: { name: "response", schema: { type: "object" }, strict: true },
  });
  assert.equal(((budget.tools as JsonMap[])[0]!.function as JsonMap).strict, true);
  const adaptive = messagesToChat(
    parse({ model: "m", messages: [{ role: "user", content: "x" }], thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } }),
  );
  assert.equal(adaptive.reasoning_effort, "xhigh");
  const off = messagesToChat(
    parse({ model: "m", messages: [{ role: "user", content: "x" }], thinking: { type: "disabled" }, output_config: { effort: "high" } }),
  );
  assert.equal(off.reasoning_effort, undefined);
  const warm = messagesToChat(parse({ model: "m", max_tokens: 0, messages: [{ role: "user", content: "x" }] }));
  assert.equal(warm.max_tokens, undefined);
});

test("chat reasoning becomes Anthropic thinking blocks and stream events", async () => {
  const message = chatToMessage(
    {
      choices: [
        { index: 0, message: { role: "assistant", content: "42", reasoning_content: "think" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    },
    "alias",
  );
  assert.deepEqual((message.content as JsonMap[])[0], { type: "thinking", thinking: "think", signature: "" });
  assert.deepEqual((message.content as JsonMap[])[1], { type: "text", text: "42" });
  const events = await anthropicEvents(
    pipeChatStream(
      chatSse([
        chunk({ role: "assistant", reasoning_content: "a" }),
        chunk({ reasoning_content: "b" }),
        chunk({ content: "done" }),
        chunk({}, "stop"),
        "[DONE]",
      ]),
      new MessagesStreamEncoder("alias"),
    ),
  );
  const kinds = events.map((e) =>
    e.event === "content_block_delta" ? `delta:${String((e.data.delta as JsonMap).type)}` : e.event,
  );
  assert.deepEqual(kinds, [
    "message_start",
    "content_block_start",
    "delta:thinking_delta",
    "delta:thinking_delta",
    "delta:signature_delta",
    "content_block_stop",
    "content_block_start",
    "delta:text_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.deepEqual((events[1]!.data.content_block as JsonMap).type, "thinking");
});

test("Anthropic passthrough headers keep version and beta flags only", () => {
  const headers = new Headers({
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "context-1m-2025-08-07",
    "x-api-key": "secret",
  });
  assert.deepEqual(anthropicPassthroughHeaders(headers), {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "context-1m-2025-08-07",
  });
  assert.deepEqual(anthropicPassthroughHeaders(new Headers()), {});
});

test("chat completion converts to an Anthropic message", () => {
  const message = chatToMessage(
    {
      id: "chatcmpl-1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "let me check",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, prompt_tokens_details: { cached_tokens: 10 } },
    },
    "claude-alias",
  );
  assert.match(String(message.id), /^msg_/);
  assert.equal(message.type, "message");
  assert.equal(message.role, "assistant");
  assert.equal(message.model, "claude-alias");
  assert.deepEqual(message.content, [
    { type: "text", text: "let me check" },
    { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
  ]);
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.stop_sequence, null);
  assert.deepEqual(message.usage, {
    input_tokens: 20,
    output_tokens: 7,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 10,
  });
  const cases: [string | null, string][] = [
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
    [null, "end_turn"],
  ];
  for (const [finish, stop] of cases) {
    const out = chatToMessage({ choices: [{ message: { content: "x" }, finish_reason: finish }] }, "m");
    assert.equal(out.stop_reason, stop);
  }
  const matched = chatToMessage(
    { choices: [{ message: { content: "x" }, finish_reason: "stop", stop_reason: "END" }] },
    "m",
  );
  assert.equal(matched.stop_reason, "stop_sequence");
  assert.equal(matched.stop_sequence, "END");
  const empty = chatToMessage({ choices: [{ message: { content: null }, finish_reason: "stop" }] }, "m");
  assert.deepEqual(empty.content, [{ type: "text", text: "" }]);
});

test("chat SSE stream converts to the Anthropic event sequence", async () => {
  const res = pipeChatStream(
    chatSse([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({
        tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
      chunk({}, "tool_calls"),
      { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 11, completion_tokens: 5 } },
      "[DONE]",
      "[DONE]",
    ]),
    new MessagesStreamEncoder("claude-alias", { inputTokens: 9 }),
  );
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = await anthropicEvents(res);
  assert.deepEqual(
    events.map((e) => e.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  const start = events[0]!.data.message as JsonMap;
  assert.match(String(start.id), /^msg_/);
  assert.equal(start.model, "claude-alias");
  assert.deepEqual(start.content, []);
  assert.equal((start.usage as JsonMap).input_tokens, 9);
  assert.deepEqual(events[1]!.data, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  assert.deepEqual(events[2]!.data.delta, { type: "text_delta", text: "Hel" });
  assert.deepEqual(events[4]!.data, { type: "content_block_stop", index: 0 });
  assert.deepEqual(events[5]!.data, {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} },
  });
  assert.deepEqual(events[6]!.data, {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"q":' },
  });
  assert.deepEqual(events[9]!.data, {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { input_tokens: 11, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
});

test("streamed tool calls buffer late names and finish reasons map to stop reasons", async () => {
  const events = await anthropicEvents(
    pipeChatStream(
      chatSse([
        chunk({ content: "hi" }),
        chunk({ tool_calls: [{ index: 0, id: "call_9", function: { arguments: '{"a":1}' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { name: "late" } }] }),
        chunk({}, "stop"),
      ]),
      new MessagesStreamEncoder("m"),
    ),
  );
  const start = events.find((e) => e.event === "content_block_start" && (e.data.content_block as JsonMap).type === "tool_use");
  assert.deepEqual(start?.data.content_block, { type: "tool_use", id: "call_9", name: "late", input: {} });
  const args = events.filter((e) => (e.data.delta as JsonMap | undefined)?.type === "input_json_delta");
  assert.equal(args.length, 1);
  assert.equal((args[0]!.data.delta as JsonMap).partial_json, '{"a":1}');
  const delta = events.find((e) => e.event === "message_delta")!;
  assert.equal((delta.data.delta as JsonMap).stop_reason, "tool_use");
  const plain = await anthropicEvents(
    pipeChatStream(chatSse([chunk({ content: "x" }), chunk({}, "length")]), new MessagesStreamEncoder("m")),
  );
  assert.equal(((plain.at(-2)!.data.delta as JsonMap).stop_reason), "max_tokens");
  assert.equal(plain.at(-1)!.event, "message_stop");
});

test("upstream stream failure becomes an Anthropic error event", async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: "partial" }))}\n\n`));
      controller.error(new Error("socket hang up"));
    },
  });
  const events = await anthropicEvents(pipeChatStream(new Response(broken), new MessagesStreamEncoder("m")));
  const last = events.at(-1)!;
  assert.equal(last.event, "error");
  assert.deepEqual(last.data, { type: "error", error: { type: "api_error", message: "socket hang up" } });
});

test("Anthropic error envelope and x-api-key auth", () => {
  assert.deepEqual(anthropicErrorBody(400, "bad"), {
    type: "error",
    error: { type: "invalid_request_error", message: "bad" },
  });
  const types: [number, string][] = [
    [401, "authentication_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [500, "api_error"],
    [502, "api_error"],
    [503, "overloaded_error"],
    [529, "overloaded_error"],
  ];
  for (const [status, type] of types) {
    assert.equal(anthropicErrorBody(status, "x").error.type, type);
  }
  const keyed = apiKeyRequest(
    new Request("http://hub.local/v1/messages", { method: "POST", headers: { "x-api-key": "sk-hub-1" } }),
  );
  assert.equal(keyed.headers.get("authorization"), "Bearer sk-hub-1");
  const bearer = new Request("http://hub.local/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer a", "x-api-key": "b" },
  });
  assert.equal(apiKeyRequest(bearer), bearer);
});
