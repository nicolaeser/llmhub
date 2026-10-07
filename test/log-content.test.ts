import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatStreamTranscript,
  logPayload,
  MessagesStreamTranscript,
  requestTranscript,
  responseTranscript,
} from "@/lib/gateway/log-content";
import { withTrace } from "@/lib/gateway/gate";
import type { Principal } from "@/types/gateway";

test("logPayload elides binary data and embedding vectors without marking truncation", () => {
  const stored = logPayload({
    image: `data:image/png;base64,${"A".repeat(2000)}`,
    embedding: Array.from({ length: 128 }, (_, i) => i / 128),
    text: "hello",
  });
  assert.deepEqual(stored, {
    value: { image: "[binary · 2022 chars]", embedding: "[vector · 128 numbers]", text: "hello" },
    truncated: false,
  });
  assert.equal(logPayload(undefined), null);
  assert.equal(logPayload(null), null);
});

test("logPayload shortens long strings and huge payloads and flags them", () => {
  const long = "word ".repeat(20_000);
  const stored = logPayload({ messages: [{ role: "user", content: long }] });
  assert.equal(stored?.truncated, true);
  const content = (stored?.value as { messages: { content: string }[] }).messages[0]!.content;
  assert.ok(content.length < long.length);
  assert.match(content, /… \[\+\d+ chars\]$/);

  const many = Array.from({ length: 1_000 }, () => "x ".repeat(4_000));
  const shrunk = logPayload({ input: many });
  assert.equal(shrunk?.truncated, true);
  assert.ok(JSON.stringify(shrunk?.value).length <= 1_000_000);
});

test("ChatStreamTranscript rebuilds content, reasoning, and tool calls per choice", () => {
  const transcript = new ChatStreamTranscript();
  assert.equal(transcript.result(), null);
  transcript.push({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "think " } }] });
  transcript.push({ choices: [{ index: 0, delta: { content: "Hel" } }] });
  transcript.push({ choices: [{ index: 0, delta: { content: "lo" } }] });
  transcript.push({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: '{"q":' } }] } }],
  });
  transcript.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] });
  transcript.push({ choices: [], usage: { prompt_tokens: 3 } });
  assert.deepEqual(transcript.result(), {
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello",
          reasoning_content: "think ",
          tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
        },
      },
    ],
  });
});

test("MessagesStreamTranscript rebuilds Anthropic text, thinking, and tool input", () => {
  const transcript = new MessagesStreamTranscript();
  transcript.push({ index: 0, content_block: { type: "thinking", thinking: "" } }, "content_block_start");
  transcript.push({ index: 0, delta: { type: "thinking_delta", thinking: "plan" } }, "content_block_delta");
  transcript.push({ index: 1, content_block: { type: "text", text: "" } }, "content_block_start");
  transcript.push({ index: 1, delta: { type: "text_delta", text: "Hi [EMAIL_ADDRESS]" } }, "content_block_delta");
  transcript.push({ index: 2, content_block: { type: "tool_use", id: "t1", name: "get", input: {} } }, "content_block_start");
  transcript.push({ index: 2, delta: { type: "input_json_delta", partial_json: '{"id":' } }, "content_block_delta");
  transcript.push({ index: 2, delta: { type: "input_json_delta", partial_json: "7}" } }, "content_block_delta");
  assert.deepEqual(transcript.result(), {
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "Hi [EMAIL_ADDRESS]" },
      { type: "tool_use", id: "t1", name: "get", input: { id: 7 } },
    ],
  });
});

test("requestTranscript reads chat, Anthropic, Responses, and prompt bodies", () => {
  assert.deepEqual(
    requestTranscript({
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "x" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "1", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "1", content: "42" },
      ],
    }),
    [
      { role: "system", kind: "text", text: "Be brief" },
      { role: "user", kind: "text", text: "Look" },
      { role: "user", kind: "media", text: "image" },
      { role: "assistant", kind: "tool_call", name: "f", text: "{}" },
      { role: "tool", kind: "tool_result", name: "", text: "42" },
    ],
  );
  assert.deepEqual(
    requestTranscript({
      system: [{ type: "text", text: "Rules" }],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", name: "get", input: { id: 1 } }] },
        { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "ok" }] }] },
      ],
    }),
    [
      { role: "system", kind: "text", text: "Rules" },
      { role: "assistant", kind: "tool_call", name: "get", text: '{"id":1}' },
      { role: "user", kind: "tool_result", text: "ok" },
    ],
  );
  assert.deepEqual(
    requestTranscript({
      instructions: "Answer in German",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Hallo" }] },
        { type: "function_call_output", call_id: "c", output: "done" },
      ],
    }),
    [
      { role: "system", kind: "text", text: "Answer in German" },
      { role: "user", kind: "text", text: "Hallo" },
      { role: "tool", kind: "tool_result", text: "done" },
    ],
  );
  assert.deepEqual(requestTranscript({ prompt: ["a", "b"] }), [
    { role: "user", kind: "text", text: "a" },
    { role: "user", kind: "text", text: "b" },
  ]);
  assert.deepEqual(requestTranscript({ input: "embed me" }), [{ role: "user", kind: "text", text: "embed me" }]);
});

test("responseTranscript reads chat, completions, Anthropic, Responses, audio, and images", () => {
  assert.deepEqual(
    responseTranscript({
      choices: [{ message: { role: "assistant", content: "Hi", reasoning_content: "why" } }],
    }),
    [
      { role: "assistant", kind: "reasoning", text: "why" },
      { role: "assistant", kind: "text", text: "Hi" },
    ],
  );
  assert.deepEqual(responseTranscript({ choices: [{ text: "done" }] }), [
    { role: "assistant", kind: "text", text: "done" },
  ]);
  assert.deepEqual(
    responseTranscript({ type: "message", role: "assistant", content: [{ type: "text", text: "Yo" }] }),
    [{ role: "assistant", kind: "text", text: "Yo" }],
  );
  assert.deepEqual(
    responseTranscript({
      object: "response",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Out" }] },
        { type: "function_call", name: "f", arguments: "{}" },
      ],
    }),
    [
      { role: "assistant", kind: "text", text: "Out" },
      { role: "assistant", kind: "tool_call", name: "f", text: "{}" },
    ],
  );
  assert.deepEqual(responseTranscript({ text: "transcribed" }), [
    { role: "assistant", kind: "text", text: "transcribed" },
  ]);
  assert.deepEqual(responseTranscript({ data: [{ b64_json: "[binary · 9 chars]" }] }), [
    { role: "assistant", kind: "media", text: "image" },
  ]);
  assert.deepEqual(responseTranscript({ data: [{ embedding: "[vector · 1536 numbers]" }] }), []);
});

test("withTrace gives every request its own PII trace", () => {
  const principal: Principal = { actor: "a", teamId: "", orgId: "", userId: "u", memberId: "", models: [], routeLimits: {} };
  const first = withTrace(principal, "/v1/chat/completions");
  const second = withTrace(principal, "batch:/v1/embeddings");
  first.trace?.piiInput.add("EMAIL_ADDRESS");
  assert.equal(principal.trace, undefined);
  assert.equal(first.trace?.endpoint, "/v1/chat/completions");
  assert.equal(second.trace?.piiInput.size, 0);
  assert.equal(second.trace?.piiMode, "");
});
