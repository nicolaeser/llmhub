import assert from "node:assert/strict";
import test from "node:test";
import { replayDraft } from "@/lib/gateway/log-replay";

test("replayDraft splits a chat request into system, history, and the last user prompt", () => {
  const draft = replayDraft("/v1/chat/completions", {
    model: "gpt",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "developer", content: [{ type: "text", text: "Answer in German." }] },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hallo" },
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  });
  assert.deepEqual(draft, {
    system: "Be brief.\n\nAnswer in German.",
    history: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hallo" },
    ],
    prompt: { text: "What is this?", images: ["https://example.com/cat.png"] },
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    dropped: false,
  });
});

test("replayDraft reads Anthropic messages and converts their tools", () => {
  const draft = replayDraft("/v1/messages", {
    system: [{ type: "text", text: "You are terse." }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Weather?" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "check" },
          { type: "text", text: "Looking it up." },
          { type: "tool_use", id: "t1", name: "weather", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "sunny" }] },
      { role: "user", content: "And tomorrow?" },
    ],
    tools: [
      { name: "weather", description: "Get weather", input_schema: { type: "object" } },
      { type: "web_search_20250305", name: "web_search" },
    ],
  });
  assert.deepEqual(draft, {
    system: "You are terse.",
    history: [
      { role: "user", content: "Weather?" },
      { role: "assistant", content: "Looking it up." },
    ],
    prompt: { text: "And tomorrow?", images: [] },
    tools: [
      {
        type: "function",
        function: { name: "weather", description: "Get weather", parameters: { type: "object" } },
      },
    ],
    dropped: true,
  });
});

test("replayDraft reads Responses input, instructions, and plain prompts", () => {
  assert.deepEqual(
    replayDraft("/v1/responses", {
      instructions: "Use bullet points.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "List fruit" }] },
        { type: "function_call", name: "noop", arguments: "{}" },
        { type: "message", role: "user", content: [{ type: "input_image", image_url: "[binary · 2022 chars]" }] },
        { role: "user", content: "Only red ones" },
      ],
      tools: [{ type: "function", name: "noop", parameters: { type: "object" } }],
    }),
    {
      system: "Use bullet points.",
      history: [{ role: "user", content: "List fruit" }],
      prompt: { text: "Only red ones", images: [] },
      tools: [{ type: "function", function: { name: "noop", parameters: { type: "object" } } }],
      dropped: true,
    },
  );
  assert.deepEqual(replayDraft("/v1/responses", { input: "Hello" })?.prompt, { text: "Hello", images: [] });
  assert.deepEqual(replayDraft("/v1/completions", { prompt: "Once upon" })?.prompt, {
    text: "Once upon",
    images: [],
  });
  assert.equal(replayDraft("batch:/v1/chat/completions", { messages: [{ role: "user", content: "x" }] })?.dropped, false);
});

test("replayDraft flags trailing assistant prefill and rejects non-chat requests", () => {
  const prefill = replayDraft("/internal-api/playground/chat", {
    messages: [
      { role: "user", content: "Write JSON" },
      { role: "assistant", content: "{" },
    ],
  });
  assert.deepEqual(prefill?.history, []);
  assert.deepEqual(prefill?.prompt, { text: "Write JSON", images: [] });
  assert.equal(prefill?.dropped, true);

  assert.equal(replayDraft("/v1/embeddings", { input: "text" }), null);
  assert.equal(replayDraft("/v1/messages/count_tokens", { messages: [{ role: "user", content: "x" }] }), null);
  assert.equal(replayDraft("/v1/chat/completions", { messages: [{ role: "assistant", content: "x" }] }), null);
  assert.equal(replayDraft("/v1/chat/completions", "[payload too large]"), null);
  assert.equal(replayDraft("/v1/chat/completions", null), null);
});
