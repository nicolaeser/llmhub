import assert from "node:assert/strict";
import test from "node:test";
import { anthropicCountBody } from "@/lib/gateway/anthropic";
import {
  chatMessagesToItems,
  chatToResponsesCountBody,
  chatToResponse,
  decodeThinking,
  encodeThinking,
  inputItems,
  pageItems,
  parseRequest,
  pipeChatStream,
  responseId,
  responseMessages,
  responseSkeleton,
  ResponsesStreamEncoder,
  responsesCountBody,
  responsesToChat,
  storedObjectId,
  storedResponse,
  visibleResponse,
} from "@/lib/gateway/responses";
import { responsesRequestSchema } from "@/schemas/responses";
import type { JsonMap } from "@/types/gateway";
import type { ResponsesRequest } from "@/types/responses";

function parse(body: JsonMap): ResponsesRequest {
  const parsed = parseRequest(responsesRequestSchema, body);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.data;
}

function chatSse(chunks: (JsonMap | string)[]): Response {
  const text = chunks
    .map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`)
    .join("");
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

function chunk(delta: JsonMap, finish: string | null = null): JsonMap {
  return { object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] };
}

async function events(res: Response): Promise<JsonMap[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = JSON.parse(lines.find((line) => line.startsWith("data: "))!.slice(6)) as JsonMap;
      assert.equal(data.type, event);
      return data;
    });
}

test("responses input items convert to chat messages", () => {
  const request = parse({
    model: "gpt-alias",
    instructions: "be terse",
    input: [
      { role: "developer", content: "dev note" },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what is in this image?" },
          { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "low" },
          { type: "input_file", file_data: "data:application/pdf;base64,UERG", filename: "a.pdf" },
        ],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "calling tools" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"a"}' },
      { type: "function_call", call_id: "call_2", name: "lookup", arguments: '{"q":"b"}' },
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "function_call_output", call_id: "call_1", output: "A" },
      { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "B" }] },
      { role: "user", content: "thanks" },
    ],
  });
  const { body, conversation } = responsesToChat(request, [{ role: "user", content: "earlier" }]);
  assert.deepEqual(body.messages, [
    { role: "system", content: "be terse" },
    { role: "user", content: "earlier" },
    { role: "system", content: "dev note" },
    {
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD", detail: "low" } },
        { type: "file", file: { file_data: "data:application/pdf;base64,UERG", filename: "a.pdf" } },
      ],
    },
    {
      role: "assistant",
      content: "calling tools",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } },
        { id: "call_2", type: "function", function: { name: "lookup", arguments: '{"q":"b"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "A" },
    { role: "tool", tool_call_id: "call_2", content: "B" },
    { role: "user", content: "thanks" },
  ]);
  assert.equal(conversation.length, 7);
  assert.deepEqual(conversation[0], { role: "user", content: "earlier" });
});

test("responses parameters map to chat parameters", () => {
  const { body } = responsesToChat(
    parse({
      model: "gpt-alias",
      input: "hi",
      tools: [
        { type: "function", name: "lookup", description: "Look up", parameters: { type: "object" }, strict: true },
      ],
      tool_choice: { type: "function", name: "lookup" },
      parallel_tool_calls: false,
      temperature: 0.2,
      top_p: 0.8,
      max_output_tokens: 128,
      user: "u-1",
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true } },
      stream: true,
      store: false,
      metadata: { tag: "x" },
    }),
    [],
  );
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: { name: "lookup", description: "Look up", parameters: { type: "object" }, strict: true },
    },
  ]);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "lookup" } });
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.8);
  assert.equal(body.max_tokens, 128);
  assert.equal(body.user, "u-1");
  assert.equal(body.reasoning_effort, "low");
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: { name: "out", schema: { type: "object" }, strict: true },
  });
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal("metadata" in body, false);
  assert.equal("store" in body, false);
  const plain = responsesToChat(parse({ model: "m", input: "x", tool_choice: "required" }), []).body;
  assert.equal(plain.tool_choice, undefined);
  assert.equal(plain.stream, undefined);
});

test("responses schema rejects built-in tools and unsupported input", () => {
  const builtin = parseRequest(responsesRequestSchema, {
    model: "m",
    input: "x",
    tools: [{ type: "web_search_preview" }],
  });
  assert.equal(builtin.ok, false);
  if (!builtin.ok) assert.match(builtin.message, /^tools\.0\.type: unsupported tool type; only function tools are supported/);
  const item = parseRequest(responsesRequestSchema, {
    model: "m",
    input: [{ type: "computer_call", id: "x" }],
  });
  assert.equal(item.ok, false);
  if (!item.ok) assert.match(item.message, /input\.0\.type: unsupported input item type/);
  const fileRef = parseRequest(responsesRequestSchema, {
    model: "m",
    input: [{ role: "user", content: [{ type: "input_image", file_id: "file_1" }] }],
  });
  assert.equal(fileRef.ok, false);
  if (!fileRef.ok) assert.match(fileRef.message, /input\.0\.content\.0\.image_url: input_image requires image_url/);
  assert.equal(parseRequest(responsesRequestSchema, { model: "m" }).ok, false);
  assert.equal(parseRequest(responsesRequestSchema, { model: "m", input: "x", background: true }).ok, false);
  assert.equal(parseRequest(responsesRequestSchema, { model: "m", previous_response_id: "resp_1" }).ok, true);
});

test("chat completion converts to a response object", () => {
  const request = parse({ model: "gpt-alias", input: "hi", instructions: "sys", metadata: { a: "b" } });
  const skeleton = responseSkeleton(request, "resp_abc", 1700000000);
  const response = chatToResponse(
    {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "hello",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    },
    skeleton,
  );
  assert.equal(response.id, "resp_abc");
  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.created_at, 1700000000);
  assert.equal(response.instructions, "sys");
  assert.deepEqual(response.metadata, { a: "b" });
  assert.equal(response.output_text, "hello");
  const output = response.output as JsonMap[];
  assert.equal(output.length, 2);
  assert.match(String(output[0]!.id), /^msg_/);
  assert.deepEqual({ ...output[0], id: "" }, {
    id: "",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "hello", annotations: [] }],
  });
  assert.match(String(output[1]!.id), /^fc_/);
  assert.deepEqual({ ...output[1], id: "" }, {
    id: "",
    type: "function_call",
    status: "completed",
    call_id: "call_1",
    name: "lookup",
    arguments: "{}",
  });
  assert.deepEqual(response.usage, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 14,
  });
  const truncated = chatToResponse(
    { choices: [{ message: { content: "cut" }, finish_reason: "length" }] },
    skeleton,
  );
  assert.equal(truncated.status, "incomplete");
  assert.deepEqual(truncated.incomplete_details, { reason: "max_output_tokens" });
  assert.equal((truncated.output as JsonMap[])[0]!.status, "incomplete");
});

test("stored responses keep conversation for previous_response_id", () => {
  assert.equal(responseId("abc"), "resp_abc");
  assert.equal(responseId("resp_abc"), "resp_abc");
  assert.equal(storedObjectId("resp_abc"), "abc");
  assert.equal(storedObjectId("abc"), "abc");
  const response = {
    object: "response",
    output: [
      { type: "message", content: [{ type: "output_text", text: "hi there" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":1}' },
    ],
  };
  assert.deepEqual(responseMessages(response), [
    {
      role: "assistant",
      content: "hi there",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":1}' } }],
    },
  ]);
  const stored = storedResponse("abc", { response, messages: [{ role: "user", content: "hi" }] });
  assert.equal(stored.response.id, "resp_abc");
  assert.deepEqual(stored.messages, [{ role: "user", content: "hi" }]);
  const legacy = storedResponse("old", { ...response, id: "old" });
  assert.equal(legacy.response.id, "resp_old");
  assert.equal(legacy.messages.length, 1);
  const next = responsesToChat(parse({ model: "m", previous_response_id: "resp_abc", input: "more", instructions: "new" }), stored.messages);
  assert.deepEqual(next.body.messages, [
    { role: "system", content: "new" },
    { role: "user", content: "hi" },
    { role: "user", content: "more" },
  ]);
  assert.deepEqual(next.conversation, [
    { role: "user", content: "hi" },
    { role: "user", content: "more" },
  ]);
});

test("chat SSE stream converts to Responses streaming events", async () => {
  const request = parse({ model: "gpt-alias", input: "hi", stream: true });
  const encoder = new ResponsesStreamEncoder(responseSkeleton(request, "resp_1", 1700000000));
  let stored: JsonMap | null = null;
  const res = pipeChatStream(
    chatSse([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
      chunk({}, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 } },
      "[DONE]",
    ]),
    encoder,
    () => {
      stored = encoder.result();
    },
  );
  const list = await events(res);
  assert.deepEqual(
    list.map((e) => e.type),
    [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  assert.deepEqual(
    list.map((e) => e.sequence_number),
    list.map((_, i) => i),
  );
  const created = list[0]!.response as JsonMap;
  assert.equal(created.id, "resp_1");
  assert.equal(created.status, "in_progress");
  assert.equal(list[4]!.delta, "Hel");
  assert.equal(list[4]!.output_index, 0);
  assert.equal(list[6]!.text, "Hello");
  assert.deepEqual(list[7]!.part, { type: "output_text", text: "Hello", annotations: [] });
  const fnAdded = list[9]!.item as JsonMap;
  assert.equal(fnAdded.type, "function_call");
  assert.equal(fnAdded.call_id, "call_1");
  assert.equal(fnAdded.name, "lookup");
  assert.equal(list[9]!.output_index, 1);
  assert.equal(list[12]!.arguments, '{"q":"x"}');
  assert.equal(list[12]!.name, "lookup");
  const done = list[14]!.response as JsonMap;
  assert.equal(done.status, "completed");
  assert.equal(done.output_text, "Hello");
  assert.equal((done.output as JsonMap[]).length, 2);
  assert.equal(((done.output as JsonMap[])[1] as JsonMap).arguments, '{"q":"x"}');
  assert.deepEqual(done.usage, {
    input_tokens: 6,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 9,
  });
  assert.deepEqual(stored, done);
});

test("truncated and failed streams emit incomplete and failed events", async () => {
  const request = parse({ model: "m", input: "hi" });
  const incomplete = await events(
    pipeChatStream(
      chatSse([chunk({ content: "cut" }), chunk({}, "length")]),
      new ResponsesStreamEncoder(responseSkeleton(request, "resp_2", 1)),
    ),
  );
  const last = incomplete.at(-1)!;
  assert.equal(last.type, "response.incomplete");
  assert.deepEqual((last.response as JsonMap).incomplete_details, { reason: "max_output_tokens" });
  const failed = await events(
    pipeChatStream(
      chatSse([chunk({ content: "x" }), { error: { message: "upstream exploded" } }]),
      new ResponsesStreamEncoder(responseSkeleton(request, "resp_3", 1)),
    ),
  );
  const end = failed.at(-1)!;
  assert.equal(end.type, "response.failed");
  assert.equal((end.response as JsonMap).status, "failed");
  assert.deepEqual((end.response as JsonMap).error, { code: "server_error", message: "upstream exploded" });
});

test("chat reasoning becomes a reasoning item whose encrypted_content round-trips signed thinking", () => {
  const request = parse({ model: "m", input: "q", reasoning: { effort: "high", summary: "auto" } });
  const blocks = [{ type: "thinking", thinking: "plan", signature: "sig" }];
  const response = chatToResponse(
    {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "plan",
            thinking_blocks: blocks,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 6 } },
    },
    responseSkeleton(request, "resp_r", 1700000000),
  );
  const output = response.output as JsonMap[];
  assert.equal(output[0]!.type, "reasoning");
  assert.deepEqual(output[0]!.summary, [{ type: "summary_text", text: "plan" }]);
  assert.deepEqual(decodeThinking(output[0]!.encrypted_content), blocks);
  assert.equal(output[1]!.type, "function_call");
  assert.deepEqual((response.usage as JsonMap).output_tokens_details, { reasoning_tokens: 6 });
  const hidden = visibleResponse(response, null);
  assert.equal("encrypted_content" in (hidden.output as JsonMap[])[0]!, false);
  const shown = visibleResponse(response, ["reasoning.encrypted_content"]);
  assert.equal(typeof (shown.output as JsonMap[])[0]!.encrypted_content, "string");
  assert.deepEqual(responseMessages(response)[0]!.thinking_blocks, blocks);

  const next = parse({
    model: "m",
    input: [
      { role: "user", content: "q" },
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encodeThinking(blocks) },
      { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "gAAAA-foreign" },
    ],
  });
  const { body } = responsesToChat(next, []);
  const messages = body.messages as JsonMap[];
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
    thinking_blocks: blocks,
  });
  assert.equal(messages.length, 3);
  assert.deepEqual(decodeThinking("not-ours"), []);
});

test("responses pass verbosity, prompt cache key, and safety identifier to chat", () => {
  const { body } = responsesToChat(
    parse({
      model: "m",
      input: "x",
      text: { verbosity: "low" },
      prompt_cache_key: "tenant-1",
      safety_identifier: "user-hash",
    }),
    [],
  );
  assert.equal(body.verbosity, "low");
  assert.equal(body.prompt_cache_key, "tenant-1");
  assert.equal(body.safety_identifier, "user-hash");
});

test("streamed reasoning emits reasoning summary events before the message", async () => {
  const request = parse({ model: "m", input: "hi", stream: true });
  const encoder = new ResponsesStreamEncoder(responseSkeleton(request, "resp_s", 1700000000), null);
  const list = await events(
    pipeChatStream(
      chatSse([
        chunk({ role: "assistant", reasoning_content: "thin" }),
        chunk({ reasoning_content: "king" }),
        chunk({ thinking_blocks: [{ type: "thinking", thinking: "thinking", signature: "s" }] }),
        chunk({ content: "answer" }),
        chunk({}, "stop"),
        "[DONE]",
      ]),
      encoder,
    ),
  );
  assert.deepEqual(
    list.map((e) => e.type),
    [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  assert.equal(list[6]!.text, "thinking");
  assert.equal(list[6]!.summary_index, 0);
  const reasoningDone = list[8]!.item as JsonMap;
  assert.equal(reasoningDone.type, "reasoning");
  assert.equal("encrypted_content" in reasoningDone, false);
  assert.equal(list[11]!.output_index, 1);
  const stored = encoder.result();
  const storedReasoning = (stored.output as JsonMap[])[0]!;
  assert.deepEqual(decodeThinking(storedReasoning.encrypted_content), [
    { type: "thinking", thinking: "thinking", signature: "s" },
  ]);
  const completed = list[15]!.response as JsonMap;
  assert.equal("encrypted_content" in (completed.output as JsonMap[])[0]!, false);
});

test("input items get ids and page in OpenAI list order", () => {
  const items = inputItems([
    { type: "message", role: "user", content: "a" },
    { type: "function_call_output", call_id: "c", output: "o" },
  ]);
  assert.match(String(items[0]!.id), /^msg_/);
  assert.deepEqual(items[0]!.content, [{ type: "input_text", text: "a" }]);
  assert.match(String(items[1]!.id), /^item_/);
  assert.deepEqual(inputItems("hi")[0]!.content, [{ type: "input_text", text: "hi" }]);
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(pageItems(rows, { limit: "2" }), {
    object: "list",
    data: [{ id: "c" }, { id: "b" }],
    first_id: "c",
    last_id: "b",
    has_more: true,
  });
  assert.deepEqual(pageItems(rows, { order: "asc", after: "a" }).data, [{ id: "b" }, { id: "c" }]);
  assert.equal(storedResponse("x", { response: {}, messages: [] }).input.length, 0);
});

test("input token count bodies keep only countable fields and inline stored history", () => {
  const request = parse({ model: "m", input: "next", store: false, stream: false, tools: [] });
  const history = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "out" },
  ];
  const body = responsesCountBody({ model: "m", input: "next", store: false, stream: false, tools: [] }, request, history);
  assert.deepEqual(Object.keys(body).sort(), ["input", "model", "tools"]);
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: "first" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] },
    { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "out" },
    { type: "message", role: "user", content: "next" },
  ]);
  assert.deepEqual(
    anthropicCountBody({ model: "c", messages: [], max_tokens: 10, temperature: 1, system: "s" }),
    { model: "c", messages: [], system: "s" },
  );
  assert.deepEqual(
    chatMessagesToItems([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }]),
    [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://x/y.png", detail: "auto" }] }],
  );
});

test("chat bodies convert to a Responses input_tokens body for OpenAI token counting", () => {
  assert.deepEqual(
    chatToResponsesCountBody(
      {
        model: "alias",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "hi" },
        ],
        tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" }, strict: true } }],
        reasoning_effort: "low",
        max_tokens: 100,
      },
      "gpt-6-sol",
    ),
    {
      model: "gpt-6-sol",
      input: [
        { type: "message", role: "system", content: "rules" },
        { type: "message", role: "user", content: "hi" },
      ],
      tools: [{ type: "function", name: "f", parameters: { type: "object" }, description: "d", strict: true }],
      reasoning: { effort: "low" },
    },
  );
});
