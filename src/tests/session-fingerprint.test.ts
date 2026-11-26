import assert from "node:assert/strict";
import test from "node:test";
import {
  FINGERPRINT_LIMIT_BYTES,
  SESSION_AFFINITY_HEADER,
  affinitySession,
  affinitySessionSource,
  conversationFingerprint,
} from "@/lib/gateway/routing/session-fingerprint";
import type { JsonMap } from "@/types/gateway";

const SYSTEM = "You are a careful coding assistant.";

function session(body: JsonMap | null | undefined, headers?: Record<string, string>, scope = "project-a", alias = "qwen"): string {
  return affinitySession({ body, headers, scope, alias });
}

function chat(task: string, ...rest: JsonMap[]): JsonMap {
  return {
    model: "qwen",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: task },
      ...rest,
    ],
  };
}

function messages(task: string, ...rest: JsonMap[]): JsonMap {
  return {
    model: "claude",
    system: [{ type: "text", text: SYSTEM }],
    messages: [{ role: "user", content: [{ type: "text", text: task }] }, ...rest],
  };
}

function image(data: string): JsonMap {
  return { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } };
}

test("a chat conversation keeps its key while turns are appended", () => {
  const first = session(chat("Fix the parser"));
  assert.match(first, /^[0-9a-f]{32}$/);
  const later = chat(
    "Fix the parser",
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "file contents" },
    { role: "assistant", content: "Done." },
    { role: "system", content: "Injected reminder" },
    { role: "user", content: "Now add tests" },
  );
  assert.equal(session(later), first);
});

test("a Messages conversation keeps its key across turns and cache_control moves", () => {
  const first = messages("Summarize the log");
  const later: JsonMap = {
    model: "claude",
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2; cch=abc;" },
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "Summarize the log", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { url: "https://example.test" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "lines" }] },
      { role: "assistant", content: [{ type: "text", text: "Summary." }] },
      { role: "user", content: "Thanks" },
    ],
  };
  assert.equal(session(later), session(first));
});

test("a Responses conversation keeps its key from string input to item history", () => {
  const first: JsonMap = { model: "qwen", instructions: SYSTEM, input: "Plan the migration" };
  const later: JsonMap = {
    model: "qwen",
    instructions: SYSTEM,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Plan the migration" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Plan." }] },
      { type: "function_call", call_id: "f1", name: "run", arguments: "{}" },
      { type: "function_call_output", call_id: "f1", output: "ok" },
      { role: "user", content: "Go on" },
    ],
  };
  assert.equal(session(later), session(first));
});

test("tool items before the first user message are ignored", () => {
  const plain = chat("Fix the parser");
  const withTools: JsonMap = {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "boot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c0", content: "booted" },
      { role: "user", content: "Fix the parser" },
    ],
  };
  assert.equal(session(withTools), session(plain));
});

test("different first user messages get different keys even with a shared system prompt", () => {
  assert.notEqual(session(chat("Fix the parser")), session(chat("Write the docs")));
  assert.notEqual(session(messages("Fix the parser")), session(messages("Write the docs")));
  const other = { ...chat("Fix the parser"), messages: [{ role: "system", content: "Other prompt" }, { role: "user", content: "Fix the parser" }] };
  assert.notEqual(session(other), session(chat("Fix the parser")));
});

test("requests without a first user message derive nothing", () => {
  assert.equal(session(null), "");
  assert.equal(session(undefined), "");
  assert.equal(session({}), "");
  assert.equal(session({ messages: [{ role: "system", content: SYSTEM }] }), "");
  assert.equal(session({ messages: [{ role: "assistant", content: "hi" }] }), "");
  assert.equal(session({ messages: [{ role: "user", content: "   " }] }), "");
  assert.equal(conversationFingerprint({ system: SYSTEM, messages: [] }), "");
  assert.equal(affinitySessionSource({ body: {}, scope: "p", alias: "a" }), null);
});

test("line endings and trailing whitespace do not change the key but indentation does", () => {
  assert.equal(session(chat("line one\r\nline two  \n")), session(chat("line one\nline two")));
  assert.notEqual(session(chat("if x:\n    run()")), session(chat("if x:\n  run()")));
});

test("explicit client keys beat the affinity header, which beats the fingerprint", () => {
  const header = { [SESSION_AFFINITY_HEADER]: "conv-1" };
  const cached = { ...chat("Fix the parser"), prompt_cache_key: "pck-1" };
  assert.equal(affinitySessionSource({ body: cached, headers: header, scope: "p", alias: "a" })?.source, "client");
  assert.equal(session(cached, header), session({ ...chat("Other task"), prompt_cache_key: "pck-1" }));

  const claudeMeta = { ...messages("Fix"), metadata: { user_id: JSON.stringify({ device_id: "d", session_id: "run-1" }) } };
  assert.equal(affinitySessionSource({ body: claudeMeta, headers: header, scope: "p", alias: "a" })?.source, "client");
  assert.equal(
    session(claudeMeta, header),
    session(messages("Other"), { "X-Claude-Code-Session-Id": "run-1", [SESSION_AFFINITY_HEADER]: "conv-2" }),
  );

  assert.equal(affinitySessionSource({ body: chat("Fix"), headers: header, scope: "p", alias: "a" })?.source, "header");
  assert.equal(session(chat("Fix"), header), session(chat("Something else"), { "X-Session-Affinity": "  conv-1 " }));
  assert.notEqual(session(chat("Fix"), header), session(chat("Fix")));

  assert.equal(affinitySessionSource({ body: chat("Fix"), scope: "p", alias: "a" })?.source, "fingerprint");
  assert.equal(session(chat("Fix"), { [SESSION_AFFINITY_HEADER]: "x".repeat(513) }), session(chat("Fix")));
  assert.equal(affinitySession({ body: chat("Fix"), scope: "p", alias: "a" }), affinitySessionSource({ body: chat("Fix"), scope: "p", alias: "a" })?.session);
});

test("sources never collide with each other", () => {
  const fingerprint = conversationFingerprint(chat("Fix"));
  assert.notEqual(session({ prompt_cache_key: fingerprint }), session(chat("Fix")));
  assert.notEqual(session({}, { [SESSION_AFFINITY_HEADER]: fingerprint }), session(chat("Fix")));
});

test("scope separates tenants and alias separates groups", () => {
  const body = chat("Fix the parser");
  assert.notEqual(session(body, undefined, "project-a"), session(body, undefined, "project-b"));
  assert.notEqual(session(body, undefined, "project-a", "qwen"), session(body, undefined, "project-a", "llama"));
  assert.notEqual(session(body, undefined, "a|b", "c"), session(body, undefined, "a", "b|c"));
  const header = { [SESSION_AFFINITY_HEADER]: "conv-1" };
  assert.notEqual(session({}, header, "project-a"), session({}, header, "project-b"));
});

test("the fingerprint only reads the first 64 KB of the first user message", () => {
  const prefix = "a".repeat(FINGERPRINT_LIMIT_BYTES);
  assert.equal(session(chat(`${prefix}tail one`)), session(chat(`${prefix}tail two`)));
  assert.notEqual(session(chat(`b${prefix.slice(1)}tail`)), session(chat(`${prefix}tail`)));
  assert.notEqual(session(chat(`${prefix.slice(1)}b tail`)), session(chat(`${prefix}tail`)));
  const wide = "é".repeat(FINGERPRINT_LIMIT_BYTES);
  assert.equal(session(chat(`${wide}x`)), session(chat(`${wide}y`)));
});

test("a huge system prompt does not hide the first user message", () => {
  const huge = "s".repeat(FINGERPRINT_LIMIT_BYTES * 5);
  const one = { messages: [{ role: "system", content: huge }, { role: "user", content: "task one" }] };
  const two = { messages: [{ role: "system", content: huge }, { role: "user", content: "task two" }] };
  assert.notEqual(session(one), session(two));
});

test("images contribute a hash of their data, not the data itself", () => {
  const withImage = (data: string, detail?: string): JsonMap => ({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: [{ type: "text", text: "Describe" }, { ...image(data), ...(detail ? { detail } : {}) }] },
    ],
  });
  assert.equal(session(chat("")), "");
  assert.match(session({ messages: [{ role: "user", content: [image("AAAA")] }] }), /^[0-9a-f]{32}$/);
  assert.equal(session(withImage("AAAA")), session(withImage("AAAA", "high")));
  assert.notEqual(session(withImage("AAAA")), session(withImage("BBBB")));
  const asText = { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: "Describedata:image/png;base64,AAAA" }] };
  assert.notEqual(session(withImage("AAAA")), session(asText));
  const anthropicImage = (data: string): JsonMap => ({
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }, { type: "text", text: "Describe" }] }],
  });
  assert.notEqual(session(anthropicImage("AAAA")), session(anthropicImage("BBBB")));
});

test("Responses deltas on previous_response_id derive nothing, conversation ids stay stable", () => {
  assert.equal(conversationFingerprint({ instructions: SYSTEM, previous_response_id: "resp_1", input: "Next step" }), "");
  assert.equal(session({ previous_response_id: "resp_1", input: "Next step" }), "");
  const turn = (input: string): JsonMap => ({ instructions: SYSTEM, conversation: { id: "conv_9" }, input });
  assert.equal(session(turn("first")), session(turn("second")));
  assert.equal(session(turn("first")), session({ conversation: "conv_9", input: "third" }));
  assert.notEqual(session(turn("first")), session({ conversation: "conv_8", input: "first" }));
});
