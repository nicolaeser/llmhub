import assert from "node:assert/strict";
import test from "node:test";
import {
  chatToCodex,
  chatUsageFromResponses,
  CODEX_DEFAULT_INSTRUCTIONS,
  codexCompletion,
  CodexSseTranslator,
} from "@/lib/gateway/codex";
import { GateError } from "@/lib/gateway/errors";
import { joinPath, prepareBody, upstreamHeaders } from "@/lib/gateway/upstream";
import type { JsonMap, ResolvedDeployment } from "@/types/gateway";

function sse(events: JsonMap[]): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function translate(text: string): JsonMap[] {
  const translator = new CodexSseTranslator("gpt-5.5");
  const out: string[] = [];
  for (const line of text.split("\n")) out.push(...translator.pushLine(line));
  const flushed = translator.flush();
  if (flushed) out.push(flushed);
  return out.map((payload) => JSON.parse(payload) as JsonMap);
}

function delta(chunk: JsonMap): JsonMap {
  return ((chunk.choices as JsonMap[])[0]!.delta ?? {}) as JsonMap;
}

const codexDep: ResolvedDeployment = {
  id: "d1",
  kind: "codex",
  base_url: "https://evil.example/v1",
  model: "gpt-5.5",
  weight: 1,
  cost_input_per_1k: 0,
  cost_output_per_1k: 0,
  provider_id: "p1",
};

const completed = {
  type: "response.completed",
  response: {
    status: "completed",
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 12 },
      total_tokens: 160,
    },
  },
};

test("chatToCodex moves system prompts to instructions and keeps the conversation as items", () => {
  const body = chatToCodex({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "developer", content: [{ type: "text", text: "Answer in German." }] },
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "found" },
    ],
    max_tokens: 100,
    temperature: 0.2,
    service_tier: "priority",
    stream: false,
  });
  assert.equal(body.instructions, "Be brief.\n\nAnswer in German.");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: "Hi" },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":1}" },
    { type: "function_call_output", call_id: "call_1", output: "found" },
  ]);
  assert.equal("max_tokens" in body, false);
  assert.equal("max_output_tokens" in body, false);
  assert.equal("temperature" in body, false);
  assert.equal("service_tier" in body, false);
  assert.deepEqual(body.reasoning, { summary: "auto" });
});

test("chatToCodex maps tools, tool choice, reasoning effort, and structured output", () => {
  const body = chatToCodex({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Weather?" }],
    tools: [
      {
        type: "function",
        function: { name: "weather", description: "Forecast", parameters: { type: "object" }, strict: true },
      },
    ],
    tool_choice: { type: "function", function: { name: "weather" } },
    parallel_tool_calls: false,
    reasoning_effort: "max",
    response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" }, strict: true } },
    verbosity: "low",
    prompt_cache_key: "tenant-a",
  });
  assert.equal(body.instructions, CODEX_DEFAULT_INSTRUCTIONS);
  assert.deepEqual(body.tools, [
    { type: "function", name: "weather", parameters: { type: "object" }, description: "Forecast", strict: true },
  ]);
  assert.deepEqual(body.tool_choice, { type: "function", name: "weather" });
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "auto" });
  assert.deepEqual(body.text, {
    format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true },
    verbosity: "low",
  });
  assert.equal(body.prompt_cache_key, "tenant-a");
});

test("Codex stream events become chat completion chunks with usage", () => {
  const chunks = translate(
    sse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.reasoning_summary_text.delta", delta: "Thinking" },
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      completed,
    ]),
  );
  assert.deepEqual(delta(chunks[0]!), { role: "assistant", content: "" });
  assert.deepEqual(delta(chunks[1]!), { reasoning_content: "Thinking" });
  assert.deepEqual(
    chunks.slice(2, 4).map((chunk) => delta(chunk).content),
    ["Hel", "lo"],
  );
  const last = chunks.at(-1)!;
  assert.equal((last.choices as JsonMap[])[0]!.finish_reason, "stop");
  assert.deepEqual(last.usage, chatUsageFromResponses(completed.response.usage));
  assert.equal((last.usage as JsonMap).prompt_tokens, 120);
  assert.deepEqual((last.usage as JsonMap).prompt_tokens_details, { cached_tokens: 100 });
  assert.equal(chunks.every((chunk) => chunk.model === "gpt-5.5"), true);
});

test("Codex function calls stream as indexed tool call deltas", () => {
  const chunks = translate(
    sse([
      { type: "response.created", response: {} },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_a", name: "lookup", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"q\":" },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: "1}" },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_a", name: "lookup", arguments: "{\"q\":1}" } },
      { type: "response.output_item.done", output_index: 2, item: { type: "function_call", call_id: "call_b", name: "other", arguments: "{}" } },
      completed,
    ]),
  );
  const calls = chunks.flatMap((chunk) => (delta(chunk).tool_calls as JsonMap[] | undefined) ?? []);
  assert.deepEqual(calls, [
    { index: 0, function: { name: "lookup", arguments: "" }, id: "call_a", type: "function" },
    { index: 0, function: { arguments: "{\"q\":" } },
    { index: 0, function: { arguments: "1}" } },
    { index: 1, function: { name: "other", arguments: "{}" }, id: "call_b", type: "function" },
  ]);
  assert.equal((chunks.at(-1)!.choices as JsonMap[])[0]!.finish_reason, "tool_calls");
});

test("Codex failures and truncation surface as errors and length stops", () => {
  assert.throws(
    () => translate(sse([{ type: "response.failed", response: { error: { message: "usage limit reached" } } }])),
    (err: unknown) => err instanceof GateError && err.status === 502 && err.message === "usage limit reached",
  );
  const chunks = translate(
    sse([
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: {} } },
    ]),
  );
  assert.deepEqual(delta(chunks[0]!), { role: "assistant", content: "partial" });
  assert.equal((chunks.at(-1)!.choices as JsonMap[])[0]!.finish_reason, "length");
});

test("codexCompletion assembles a non-streaming chat completion", () => {
  const chat = codexCompletion(
    sse([
      { type: "response.created", response: {} },
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "c1", name: "f", arguments: "{}" } },
      completed,
    ]),
    "gpt-5.5",
  );
  assert.equal(chat.object, "chat.completion");
  const choice = (chat.choices as JsonMap[])[0]!;
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(choice.message, {
    role: "assistant",
    content: "Hello",
    tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
  });
  assert.equal((chat.usage as JsonMap).completion_tokens, 40);
  assert.throws(
    () => codexCompletion(sse([{ type: "response.output_text.delta", delta: "cut" }]), "gpt-5.5"),
    (err: unknown) => err instanceof GateError && err.status === 502,
  );
});

test("Codex deployments call the pinned Responses endpoint with sign-in headers", () => {
  assert.equal(joinPath(codexDep, "/chat/completions"), "https://chatgpt.com/backend-api/codex/responses");
  const body = prepareBody(codexDep, "/chat/completions", {
    model: "alias",
    messages: [{ role: "user", content: "Hi" }],
    service_tier: "priority",
    fallbacks: ["other"],
  });
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.stream, true);
  assert.equal("fallbacks" in body, false);
  assert.equal("service_tier" in body, false);
  const headers = upstreamHeaders(
    codexDep,
    { key: "token", headers: { "ChatGPT-Account-ID": "acct", originator: "llmhub" } },
    { "ChatGPT-Account-ID": "spoofed", Authorization: "Bearer other" },
  );
  assert.equal(headers.Authorization, "Bearer token");
  assert.equal(headers["ChatGPT-Account-ID"], "acct");
  assert.equal(headers["chatgpt-account-id"], undefined);
  assert.equal(headers.originator, "llmhub");
});

test("SuperGrok deployments keep the xAI wire format without premium tiers", () => {
  const grok: ResolvedDeployment = { ...codexDep, kind: "grok_build", base_url: "", model: "grok-4.6" };
  assert.equal(joinPath(grok, "/chat/completions"), "https://api.x.ai/v1/chat/completions");
  const body = prepareBody(grok, "/chat/completions", {
    model: "alias",
    messages: [{ role: "user", content: "Hi" }],
    reasoning_effort: "max",
    service_tier: "priority",
  });
  assert.equal(body.reasoning_effort, "xhigh");
  assert.equal("service_tier" in body, false);
});

test("usage limit errors carry the reset time and park the route until then", async () => {
  const { upstreamError, upstreamRetryAt } = await import("@/lib/gateway/upstream");
  const { acquireGroup, markFailure } = await import("@/lib/gateway/runtime");
  const { inPool } = await import("@/lib/gateway/route-pool");
  const limited = upstreamError(429, { error: { type: "usage_limit_reached", resets_at: 1_900_000_000 } });
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAt, 1_900_000_000_000);
  assert.equal(upstreamRetryAt(429, { error: { resets_in_seconds: 30 } }, 1_000), 31_000);
  assert.equal(upstreamRetryAt(500, { error: { resets_at: 1_900_000_000 } }), null);
  assert.equal(upstreamError(429, { error: { message: "slow down" } }).retryAt, null);

  const subscription: ResolvedDeployment = { ...codexDep, id: "sub", weight: 10 };
  const spare: ResolvedDeployment = { ...codexDep, id: "spare", weight: 5 };
  const apiKey: ResolvedDeployment = { ...codexDep, id: "api", kind: "openai", weight: 20 };
  const group = {
    alias: "gpt-5.5",
    strategy: "priority",
    billing_mode: "routed",
    price_input_per_1k: 0,
    price_output_per_1k: 0,
    price_time_zone: "UTC",
    price_windows: [],
    overflow_group: "",
    num_retries: 0,
    fallback_groups: [],
    deployments: [subscription, spare, apiKey],
    mapped: [subscription, spare, apiKey],
  };
  const subscriptions = inPool("subscription");
  const first = await acquireGroup(group, undefined, subscriptions);
  first.release();
  assert.equal(first.dep.id, "sub");
  const api = await acquireGroup(group, undefined, inPool("api"));
  api.release();
  assert.equal(api.dep.id, "api");
  markFailure(subscription, Date.now() + 3_600_000);
  for (let i = 0; i < 3; i++) {
    const next = await acquireGroup(group, undefined, subscriptions);
    next.release();
    assert.equal(next.dep.id, "spare");
  }
});
