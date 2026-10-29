import assert from "node:assert/strict";
import test from "node:test";
import { requestTranscript } from "@/lib/gateway/request-logs/log-content";
import { SessionChatBuilder, type ChatSource } from "@/lib/gateway/request-logs/session-chat";
import type { TranscriptEntry } from "@/types/logs";

const system: TranscriptEntry = { role: "system", kind: "text", text: "You are an agent" };
const ask: TranscriptEntry = { role: "user", kind: "text", text: "List the files" };
const call: TranscriptEntry = { role: "assistant", kind: "tool_call", name: "ls", text: "{}" };
const result: TranscriptEntry = { role: "user", kind: "tool_result", text: "a.txt" };
const answer: TranscriptEntry = { role: "assistant", kind: "text", text: "One file: a.txt" };
const follow: TranscriptEntry = { role: "user", kind: "text", text: "Thanks" };

function source(id: string, input: TranscriptEntry[], output: TranscriptEntry[], extra: Partial<ChatSource["request"]> = {}): ChatSource {
  return {
    request: {
      id,
      createdAt: "2026-01-01T00:00:00.000Z",
      model: "claude",
      status: 200,
      outcome: "ok",
      latencyMs: 10,
      promptTokens: 100,
      completionTokens: 5,
      cacheReadTokens: 0,
      cost: 0,
      error: "",
      ...extra,
    },
    input,
    output,
  };
}

test("a growing history is shown once and later turns only add what is new", () => {
  const builder = new SessionChatBuilder();
  builder.add(source("r1", [system, ask], [call]));
  builder.add(source("r2", [system, ask, call, result], [answer], { cacheReadTokens: 90 }));
  builder.add(source("r3", [system, ask, call, result, answer, follow], [answer]));
  const [thread, ...others] = builder.threads();
  assert.equal(others.length, 0);
  assert.deepEqual(thread!.system, [system]);
  assert.deepEqual(thread!.turns.map((turn) => turn.input), [[ask], [result], [follow]]);
  assert.deepEqual(thread!.turns.map((turn) => turn.output), [[call], [answer], [answer]]);
  assert.deepEqual(thread!.turns.map((turn) => turn.request.resent), [0, 2, 4]);
  assert.equal(thread!.turns[1]!.request.cacheReadTokens, 90);
});

test("requests with another system prompt become a side conversation and the main thread continues", () => {
  const builder = new SessionChatBuilder();
  const titler: TranscriptEntry = { role: "system", kind: "text", text: "Write a title" };
  builder.add(source("r1", [system, ask], [call]));
  builder.add(source("r2", [titler, ask], [{ role: "assistant", kind: "text", text: "Files" }]));
  builder.add(source("r3", [system, ask, call, result], [answer]));
  const threads = builder.threads();
  assert.equal(threads.length, 2);
  assert.deepEqual(threads[0]!.turns.map((turn) => turn.request.id), ["r1", "r3"]);
  assert.deepEqual(threads[1]!.turns.map((turn) => turn.request.id), ["r2"]);
});

test("a request sent again with the same reply is marked instead of duplicated", () => {
  const builder = new SessionChatBuilder();
  builder.add(source("r1", [system, ask], [answer]));
  builder.add(source("r2", [system, ask], [answer], { outcome: "cache_hit" }));
  const [thread] = builder.threads();
  assert.equal(thread!.turns[1]!.request.repeated, true);
  assert.deepEqual(thread!.turns[1]!.output, []);
  assert.deepEqual(thread!.turns[1]!.input, []);
});

test("a history that shrinks starts a new thread", () => {
  const builder = new SessionChatBuilder();
  builder.add(source("r1", [system, ask, call, result, answer, follow], [answer]));
  builder.add(source("r2", [system, ask], [answer]));
  assert.equal(builder.threads().length, 2);
});

test("long entries are clipped", () => {
  const builder = new SessionChatBuilder();
  builder.add(source("r1", [system, { ...ask, text: "x".repeat(30_000) }], []));
  const text = builder.threads()[0]!.turns[0]!.input[0]!.text;
  assert.ok(text.length < 30_000);
  assert.match(text, /… \[\+10000 chars\]$/);
});

test("media parts keep a name and a remote link but never inline data", () => {
  const entries = requestTranscript({
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "[binary · 20 chars]" } },
          { type: "file", file: { filename: "report.pdf", file_data: "[binary · 90 chars]" } },
          { type: "image_url", image_url: { url: "[binary · 2022 chars]" } },
        ],
      },
    ],
  });
  assert.deepEqual(entries, [
    { role: "user", kind: "media", text: "image", url: "https://example.com/cat.png" },
    { role: "user", kind: "media", text: "image", name: "image/png" },
    { role: "user", kind: "media", text: "file", name: "report.pdf" },
    { role: "user", kind: "media", text: "image" },
  ]);
});
