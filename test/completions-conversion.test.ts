import assert from "node:assert/strict";
import test from "node:test";
import {
  chatToCompletion,
  completionPrompts,
  CompletionStreamEncoder,
  completionToChat,
  parseRequest,
  pipeChatStream,
} from "@/lib/gateway/responses";
import { completionsRequestSchema } from "@/schemas/completions";
import type { JsonMap } from "@/types/gateway";
import type { CompletionsRequest } from "@/types/responses";

function parse(body: JsonMap): CompletionsRequest {
  const parsed = parseRequest(completionsRequestSchema, body);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.data;
}

function dataLines(text: string): string[] {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      assert.ok(block.startsWith("data: "));
      return block.slice(6);
    });
}

test("legacy completion parameters pass through to chat", () => {
  const request = parse({
    model: "gpt-alias",
    prompt: "Say hi",
    max_tokens: 32,
    temperature: 0.5,
    top_p: 0.9,
    n: 2,
    stop: ["\n"],
    presence_penalty: 0.1,
    frequency_penalty: -0.2,
    logit_bias: { "50256": -100 },
    user: "u-1",
    seed: 42,
    stream: true,
    stream_options: { include_usage: true },
    suffix: "ignored",
    best_of: 3,
  });
  assert.deepEqual(completionToChat(request, "Say hi"), {
    model: "gpt-alias",
    messages: [{ role: "user", content: "Say hi" }],
    max_tokens: 32,
    temperature: 0.5,
    top_p: 0.9,
    n: 2,
    stop: ["\n"],
    presence_penalty: 0.1,
    frequency_penalty: -0.2,
    logit_bias: { "50256": -100 },
    user: "u-1",
    seed: 42,
    stream: true,
    stream_options: { include_usage: true },
  });
  const minimal = completionToChat(parse({ model: "m", prompt: "x", stop: "END" }), "x");
  assert.deepEqual(minimal, { model: "m", messages: [{ role: "user", content: "x" }], stop: "END" });
  assert.deepEqual(completionPrompts(parse({ model: "m", prompt: ["a", "b"] })), ["a", "b"]);
  assert.equal(parseRequest(completionsRequestSchema, { model: "m", prompt: [1, 2, 3] }).ok, false);
  assert.equal(parseRequest(completionsRequestSchema, { model: "m", prompt: "x", n: 0 }).ok, false);
});

test("chat results convert to a text_completion with merged choices and usage", () => {
  const out = chatToCompletion(
    [
      {
        choices: [
          { index: 0, message: { content: " one" }, finish_reason: "stop" },
          { index: 1, message: { content: " uno" }, finish_reason: "length" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      },
      {
        choices: [{ index: 0, message: { content: " two" }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
    ],
    { id: "cmpl-1", created: 10, model: "gpt-alias", n: 2, prompts: ["A", "B"], echo: true },
  );
  assert.deepEqual(out, {
    id: "cmpl-1",
    object: "text_completion",
    created: 10,
    model: "gpt-alias",
    choices: [
      { text: "A one", index: 0, logprobs: null, finish_reason: "stop" },
      { text: "A uno", index: 1, logprobs: null, finish_reason: "length" },
      { text: "B two", index: 2, logprobs: null, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  });
});

test("chat SSE stream converts to legacy completion chunks", async () => {
  const sse = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")
    .concat("data: [DONE]\n\n");
  const res = pipeChatStream(
    new Response(sse),
    new CompletionStreamEncoder({ id: "cmpl-9", created: 5, model: "gpt-alias", echo: "Say: " }),
  );
  const lines = dataLines(await res.text());
  assert.equal(lines.at(-1), "[DONE]");
  assert.equal(lines.filter((line) => line === "[DONE]").length, 1);
  const chunks = lines.slice(0, -1).map((line) => JSON.parse(line) as JsonMap);
  assert.ok(chunks.every((c) => c.id === "cmpl-9" && c.object === "text_completion" && c.created === 5));
  assert.deepEqual(
    chunks.map((c) => (c.choices as JsonMap[]).map((choice) => [choice.text, choice.finish_reason])),
    [[["Say: ", null]], [["Hel", null]], [["lo", null]], [["", "length"]], []],
  );
  assert.deepEqual(chunks.at(-1)!.usage, { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 });
});
