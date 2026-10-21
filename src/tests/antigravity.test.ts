import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  AntigravitySseTranslator,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_REDIRECT_URI,
  antigravityCompletion,
  antigravityLimits,
  antigravityModels,
  antigravityPlan,
  antigravityProject,
  antigravityTier,
  antigravityUsage,
  chatToAntigravity,
  geminiSchema,
  googleDurationSeconds,
  googleRetryAt,
  withProject,
} from "@/lib/gateway/upstreams/antigravity";
import { fetchAvailableModels } from "@/lib/gateway/upstreams/antigravity-api";
import { GateError } from "@/lib/gateway/errors";
import { routePool } from "@/lib/gateway/routing/route-pool";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";
import type { SignInSession } from "@/types/providers";

const settings = new Map<string, string>();

(globalThis as { prisma?: unknown }).prisma = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = settings.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
      settings.set(where.key, create.value);
      return { key: where.key, value: create.value };
    },
  },
};

const ENTERPRISE_KEY = "enterprise";

function configure(secret: string) {
  settings.set(ENTERPRISE_KEY, JSON.stringify({ antigravity: { client_secret: secret } }));
}

const realFetch = globalThis.fetch;
let calls: { url: string; body: string; headers: Record<string, string> }[] = [];

function respondWith(handler: (url: string, body: string) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, body);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  settings.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const dep: ResolvedDeployment = {
  id: "d1",
  kind: "antigravity",
  base_url: "",
  model: "claude-sonnet-4-6",
  weight: 1,
  cost_input_per_1k: 0,
  cost_output_per_1k: 0,
  provider_id: "p1",
};

const NOW = Date.parse("2026-10-12T12:00:00Z");

function sse(...events: JsonMap[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function chunk(candidate: JsonMap, usage?: JsonMap): JsonMap {
  return { response: { candidates: [candidate], ...(usage ? { usageMetadata: usage } : {}) }, traceId: "t" };
}

test("conversation turns map to Cloud Code contents with system instruction and merged roles", () => {
  const out = chatToAntigravity({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "developer", content: "Use metric units." },
      { role: "user", content: "Hi" },
      { role: "user", content: [{ type: "text", text: "and" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: "Hello" },
    ],
  });
  assert.equal(out.model, "claude-sonnet-4-6");
  const request = out.request as JsonMap;
  assert.deepEqual(request.systemInstruction, { role: "user", parts: [{ text: "Be brief.\n\nUse metric units." }] });
  assert.deepEqual(request.contents, [
    { role: "user", parts: [{ text: "Hi" }, { text: "and" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
    { role: "model", parts: [{ text: "Hello" }] },
  ]);
});

test("tool calls and results keep their ids and resolve the function name", () => {
  const out = chatToAntigravity({
    model: "gemini-3-flash",
    messages: [
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Berlin"}' } },
          { id: "call_2", type: "function", function: { name: "get_time", arguments: "not json" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "12 C" },
      { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "noon" }] },
    ],
  });
  const contents = (out.request as JsonMap).contents as JsonMap[];
  assert.deepEqual(contents[1], {
    role: "model",
    parts: [
      { functionCall: { id: "call_1", name: "get_weather", args: { city: "Berlin" } }, thoughtSignature: "skip_thought_signature_validator" },
      { functionCall: { id: "call_2", name: "get_time", args: {} }, thoughtSignature: "skip_thought_signature_validator" },
    ],
  });
  assert.deepEqual(contents[2], {
    role: "user",
    parts: [
      { functionResponse: { id: "call_1", name: "get_weather", response: { result: "12 C" } } },
      { functionResponse: { id: "call_2", name: "get_time", response: { result: "noon" } } },
    ],
  });
});

test("tools become function declarations and tool_choice maps to a calling mode", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "search",
        description: "Search the web",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false },
      },
    },
    { type: "function", function: { name: "ping", parameters: { type: "object", properties: {} } } },
    { type: "retrieval" },
  ];
  const base = { model: "gemini-3-flash", messages: [{ role: "user", content: "x" }], tools };
  const auto = chatToAntigravity({ ...base, tool_choice: "auto" }).request as JsonMap;
  assert.deepEqual(auto.tools, [
    {
      functionDeclarations: [
        {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
        { name: "ping" },
      ],
    },
  ]);
  assert.deepEqual(auto.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  const required = chatToAntigravity({ ...base, tool_choice: "required" }).request as JsonMap;
  assert.deepEqual(required.toolConfig, { functionCallingConfig: { mode: "ANY" } });
  const none = chatToAntigravity({ ...base, tool_choice: "none" }).request as JsonMap;
  assert.deepEqual(none.toolConfig, { functionCallingConfig: { mode: "NONE" } });
  const named = chatToAntigravity({ ...base, tool_choice: { type: "function", function: { name: "search" } } }).request as JsonMap;
  assert.deepEqual(named.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["search"] } });
  assert.equal((chatToAntigravity({ model: "m", messages: [{ role: "user", content: "x" }] }).request as JsonMap).tools, undefined);
});

test("tool schemas lose unsupported keywords and keep what Gemini accepts", () => {
  const schema = geminiSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    $defs: { Unit: { type: "string", enum: ["c", "f"], default: "c" } },
    properties: {
      unit: { $ref: "#/$defs/Unit" },
      note: { anyOf: [{ type: "string", minLength: 2, description: "A note" }, { type: "null" }] },
      kind: { const: "fixed" },
      count: { type: ["integer", "null"], minimum: 1, maximum: 9, default: 3 },
      tags: { type: "array" },
      nested: { allOf: [{ properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "number" } } }] },
    },
    required: ["unit", "ghost"],
  });
  assert.equal("$schema" in schema, false);
  assert.equal("additionalProperties" in schema, false);
  assert.deepEqual(schema.required, ["unit"]);
  const properties = schema.properties as Record<string, JsonMap>;
  assert.deepEqual(properties.unit, { type: "string", enum: ["c", "f"] });
  assert.deepEqual(properties.note, { type: "string", description: "A note (minLength: 2)" });
  assert.deepEqual(properties.kind, { enum: ["fixed"] });
  assert.deepEqual(properties.count, { type: "integer", description: "(minimum: 1, maximum: 9)" });
  assert.deepEqual(properties.tags, { type: "array", items: { type: "string" } });
  assert.deepEqual(properties.nested, {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "number" } },
    required: ["a"],
  });
});

test("self referencing schemas stop instead of recursing forever", () => {
  const schema = geminiSchema({
    $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
    type: "object",
    properties: { head: { $ref: "#/$defs/Node" } },
  });
  assert.equal(typeof schema, "object");
  assert.ok(JSON.stringify(schema).length < 5000);
});

test("generation settings follow the model family", () => {
  const messages = [{ role: "user", content: "x" }];
  const claude = chatToAntigravity({
    model: "claude-sonnet-4-6",
    messages,
    temperature: 0.2,
    top_p: 0.9,
    stop: ["END", ""],
    max_tokens: 4000,
  }).request as JsonMap;
  assert.deepEqual(claude.generationConfig, { temperature: 0.2, topP: 0.9, stopSequences: ["END"], maxOutputTokens: 4000 });
  const gemini = chatToAntigravity({ model: "gemini-3-flash", messages, max_tokens: 4000 }).request as JsonMap;
  assert.equal(gemini.generationConfig, undefined);
  const json = chatToAntigravity({ model: "gemini-3-flash", messages, response_format: { type: "json_object" } }).request as JsonMap;
  assert.deepEqual(json.generationConfig, { responseMimeType: "application/json" });
  const schema = chatToAntigravity({
    model: "gemini-3-flash",
    messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: "r", schema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false } },
    },
  }).request as JsonMap;
  assert.deepEqual(schema.generationConfig, {
    responseMimeType: "application/json",
    responseSchema: { type: "object", properties: { a: { type: "string" } } },
  });
});

test("reasoning effort becomes a thinking budget for Claude and a level for Gemini 3", () => {
  const messages = [{ role: "user", content: "x" }];
  const claude = chatToAntigravity({ model: "claude-sonnet-4-6", messages, reasoning_effort: "medium" }).request as JsonMap;
  assert.deepEqual(claude.generationConfig, {
    thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
    maxOutputTokens: 8192 + 1024,
  });
  const capped = chatToAntigravity({ model: "claude-sonnet-4-6", messages, reasoning_effort: "high", max_tokens: 2000 }).request as JsonMap;
  assert.deepEqual(capped.generationConfig, { maxOutputTokens: 2000 });
  const roomy = chatToAntigravity({ model: "claude-sonnet-4-6", messages, reasoning_effort: "low", max_tokens: 5000 }).request as JsonMap;
  assert.deepEqual(roomy.generationConfig, { thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 }, maxOutputTokens: 5000 });
  const high = chatToAntigravity({ model: "gemini-3-pro", messages, reasoning_effort: "high" }).request as JsonMap;
  assert.deepEqual(high.generationConfig, { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } });
  const low = chatToAntigravity({ model: "gemini-3-flash", messages, reasoning: { effort: "medium" } }).request as JsonMap;
  assert.deepEqual(low.generationConfig, { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } });
  const off = chatToAntigravity({ model: "gemini-3-flash", messages, reasoning_effort: "none" }).request as JsonMap;
  assert.equal(off.generationConfig, undefined);
});

test("remote image URLs and unsupported parts are rejected instead of dropped", () => {
  const remote = () =>
    chatToAntigravity({
      model: "m",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
    });
  assert.throws(remote, (err: unknown) => err instanceof GateError && err.status === 400 && err.code === "unsupported_parameter");
  const audio = () =>
    chatToAntigravity({ model: "m", messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] });
  assert.throws(audio, (err: unknown) => err instanceof GateError && err.status === 400);
});

test("the request envelope carries the project, a request id, and the request type", () => {
  const converted = chatToAntigravity({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "x" }] });
  const envelope = withProject(dep, { key: "k", headers: {}, project: "proj-1" }, converted);
  assert.equal(envelope.project, "proj-1");
  assert.equal(envelope.model, "claude-sonnet-4-6");
  assert.equal(envelope.requestType, "agent");
  assert.equal(envelope.userAgent, "antigravity");
  assert.match(String(envelope.requestId), /^agent-.+/);
  assert.deepEqual(envelope.request, converted.request);
  const image = withProject(dep, { key: "k", headers: {}, project: "p" }, { ...converted, model: "gemini-3.1-flash-image" });
  assert.equal(image.requestType, "image_gen");
  const other = { ...dep, kind: "openai" };
  assert.equal(withProject(other, { key: "k", headers: {}, project: "p" }, converted), converted);
});

test("text, reasoning, and finish arrive as OpenAI chunks with usage", () => {
  const translator = new AntigravitySseTranslator("alias");
  const lines = sse(
    chunk({ content: { role: "model", parts: [{ text: "thinking", thought: true }] } }),
    chunk({ content: { role: "model", parts: [{ text: "Hel" }] } }),
    chunk(
      { content: { role: "model", parts: [{ text: "lo" }] }, finishReason: "STOP" },
      { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6, totalTokenCount: 20, cachedContentTokenCount: 3 },
    ),
  ).split("\n");
  const out = lines.flatMap((line) => translator.pushLine(line)).map((payload) => JSON.parse(payload) as JsonMap);
  assert.equal(out.length, 4);
  const delta = (index: number) => ((out[index]!.choices as JsonMap[])[0]!.delta as JsonMap);
  assert.deepEqual(delta(0), { role: "assistant", reasoning_content: "thinking" });
  assert.deepEqual(delta(1), { content: "Hel" });
  assert.deepEqual(delta(2), { content: "lo" });
  const last = out[3]!;
  assert.equal(((last.choices as JsonMap[])[0] as JsonMap).finish_reason, "stop");
  assert.deepEqual(last.usage, {
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 6 },
  });
  assert.equal(translator.flush(), null);
  assert.equal(out.every((item) => item.model === "alias" && item.object === "chat.completion.chunk"), true);
});

test("function calls stream as complete tool calls and finish as tool_calls", () => {
  const translator = new AntigravitySseTranslator("alias");
  const out = sse(
    chunk({ content: { role: "model", parts: [{ functionCall: { id: "c1", name: "get_weather", args: { city: "Berlin" } } }] } }),
    chunk({ content: { role: "model", parts: [{ functionCall: { name: "get_time", args: {} } }] }, finishReason: "STOP" }),
  )
    .split("\n")
    .flatMap((line) => translator.pushLine(line))
    .map((payload) => JSON.parse(payload) as JsonMap);
  const calls = out.flatMap((item) => (((item.choices as JsonMap[])[0]!.delta as JsonMap).tool_calls as JsonMap[] | undefined) ?? []);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    index: 0,
    id: "c1",
    type: "function",
    function: { name: "get_weather", arguments: '{"city":"Berlin"}' },
  });
  assert.equal(calls[1]!.index, 1);
  assert.match(String(calls[1]!.id), /^call_/);
  const finish = ((out[out.length - 1]!.choices as JsonMap[])[0] as JsonMap).finish_reason;
  assert.equal(finish, "tool_calls");
});

test("finish reasons map to OpenAI finish reasons", () => {
  const finishOf = (reason: string) => {
    const translator = new AntigravitySseTranslator("m");
    const out = sse(chunk({ content: { role: "model", parts: [{ text: "x" }] }, finishReason: reason }))
      .split("\n")
      .flatMap((line) => translator.pushLine(line))
      .map((payload) => JSON.parse(payload) as JsonMap);
    return ((out[out.length - 1]!.choices as JsonMap[])[0] as JsonMap).finish_reason;
  };
  assert.equal(finishOf("STOP"), "stop");
  assert.equal(finishOf("MAX_TOKENS"), "length");
  assert.equal(finishOf("SAFETY"), "content_filter");
  assert.equal(finishOf("RECITATION"), "content_filter");
  assert.equal(finishOf("OTHER"), "stop");
});

test("the stream ignores comments and malformed lines, and raises upstream errors", () => {
  const translator = new AntigravitySseTranslator("m");
  assert.deepEqual(translator.pushLine(": keep-alive"), []);
  assert.deepEqual(translator.pushLine("data: not json"), []);
  assert.deepEqual(translator.pushLine("data: [DONE]"), []);
  assert.deepEqual(translator.pushLine(""), []);
  const failing = () =>
    translator.pushLine(
      `data: ${JSON.stringify({ error: { code: 429, message: "quota", details: [{ metadata: { quotaResetDelay: "30s" } }] } })}`,
    );
  assert.throws(failing, (err: unknown) => {
    if (!(err instanceof GateError)) return false;
    return err.status === 429 && err.message === "quota" && err.retryAt !== null && err.retryAt > Date.now();
  });
});

test("a stream is aggregated into one chat completion, and a cut stream fails", () => {
  const text = sse(
    chunk({ content: { role: "model", parts: [{ text: "why", thought: true }] } }),
    chunk({ content: { role: "model", parts: [{ text: "Hi " }] } }),
    chunk(
      { content: { role: "model", parts: [{ text: "there" }, { functionCall: { id: "c1", name: "f", args: { a: 1 } } }] }, finishReason: "STOP" },
      { promptTokenCount: 2, candidatesTokenCount: 3 },
    ),
  );
  const completion = antigravityCompletion(text, "alias");
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.model, "alias");
  const choice = (completion.choices as JsonMap[])[0]!;
  assert.equal(choice.finish_reason, "tool_calls");
  const message = choice.message as JsonMap;
  assert.equal(message.content, "Hi there");
  assert.equal(message.reasoning_content, "why");
  assert.deepEqual(message.tool_calls, [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }]);
  assert.deepEqual((completion.usage as JsonMap).prompt_tokens, 2);
  const cut = sse(chunk({ content: { role: "model", parts: [{ text: "partial" }] } }));
  assert.throws(() => antigravityCompletion(cut, "alias"), (err: unknown) => err instanceof GateError && err.status === 502);
});

test("usage metadata maps thinking tokens into completion tokens", () => {
  assert.deepEqual(antigravityUsage(null).total_tokens, 0);
  const usage = antigravityUsage({ promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3 });
  assert.equal(usage.completion_tokens, 5);
  assert.equal(usage.total_tokens, 10);
});

test("Google durations and 429 details become a retry time", async () => {
  const { upstreamError, upstreamRetryAt } = await import("@/lib/gateway/dispatch/upstream");
  assert.equal(googleDurationSeconds("3s"), 3);
  assert.equal(googleDurationSeconds("0.479s"), 0.479);
  assert.equal(googleDurationSeconds("1h2m3.5s"), 3723.5);
  assert.equal(googleDurationSeconds("2m"), 120);
  assert.equal(googleDurationSeconds("soon"), null);
  assert.equal(googleDurationSeconds(""), null);
  assert.equal(googleDurationSeconds(5), null);
  const stamp = new Date(NOW + 90_000).toISOString();
  assert.equal(googleRetryAt({ details: [{ metadata: { quotaResetTimeStamp: stamp } }] }, NOW), NOW + 90_000);
  assert.equal(googleRetryAt({ details: [{ metadata: { quotaResetDelay: "10s" } }] }, NOW), NOW + 10_000);
  assert.equal(googleRetryAt({ details: [{ "@type": "RetryInfo", retryDelay: "4s" }] }, NOW), NOW + 4_000);
  assert.equal(googleRetryAt({ details: [{ metadata: { quotaResetTimeStamp: new Date(NOW - 1000).toISOString() } }] }, NOW), null);
  assert.equal(googleRetryAt({}, NOW), null);
  assert.equal(googleRetryAt(null, NOW), null);
  const body = { error: { code: 429, message: "Resource exhausted", details: [{ metadata: { quotaResetDelay: "12s" } }] } };
  assert.equal(upstreamRetryAt(429, body, NOW), NOW + 12_000);
  assert.equal(upstreamRetryAt(500, body, NOW), null);
  const gate = upstreamError(429, body);
  assert.equal(gate.status, 429);
  assert.equal(gate.message, "Resource exhausted");
  assert.ok(gate.retryAt !== null && gate.retryAt > Date.now());
});

test("project and tier come from loadCodeAssist in either response shape", () => {
  assert.equal(antigravityProject({ cloudaicompanionProject: "proj-a" }), "proj-a");
  assert.equal(antigravityProject({ cloudaicompanionProject: { id: "proj-b" } }), "proj-b");
  assert.equal(antigravityProject({}), "");
  assert.equal(antigravityProject(null), "");
  assert.deepEqual(
    antigravityTier({ paidTier: { id: "g1-pro-tier" }, currentTier: { id: "standard-tier" }, allowedTiers: [{ id: "free-tier", isDefault: true }] }),
    { id: "g1-pro-tier", onboardId: "free-tier" },
  );
  assert.deepEqual(antigravityTier({ currentTier: { id: "free-tier" } }), { id: "free-tier", onboardId: "free-tier" });
  assert.deepEqual(antigravityTier({}), { id: "", onboardId: "free-tier" });
  assert.equal(antigravityPlan("g1-ultra-tier"), "ultra");
  assert.equal(antigravityPlan("g1-pro-tier"), "pro");
  assert.equal(antigravityPlan("standard-tier"), "pro");
  assert.equal(antigravityPlan("free-tier"), "free");
  assert.equal(antigravityPlan("custom"), "custom");
  assert.equal(antigravityPlan(""), "");
});

test("available models list ids, names, owners, and context sizes and skip hidden models", () => {
  const models = antigravityModels({
    models: {
      "gemini-3-flash": { displayName: "Gemini 3 Flash", maxTokens: 1_000_000 },
      "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", maxTokens: 200_000 },
      "gpt-oss-120b-medium": {},
      chat_20706: { displayName: "Chat", maxTokens: 1_000 },
      chat_23310: {},
      tab_flash_lite_preview: {},
      tab_jump_flash_lite_preview: {},
      "gemini-2.5-flash-thinking": { displayName: "Gemini 2.5 Flash Thinking" },
      "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" },
    },
  });
  assert.deepEqual(
    models.map((model) => [model.id, model.name, model.ownedBy, model.contextLength]),
    [
      ["claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic", 200_000],
      ["gemini-3-flash", "Gemini 3 Flash", "google", 1_000_000],
      ["gpt-oss-120b-medium", "gpt-oss-120b-medium", "antigravity", 0],
    ],
  );
  assert.deepEqual(antigravityModels(null), []);
});

test("per model quota becomes labelled scoped limit windows with reset times", () => {
  const reset = new Date(NOW + 3_600_000).toISOString();
  const limits = antigravityLimits(
    {
      models: {
        "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", quotaInfo: { remainingFraction: 0.25, resetTime: reset } },
        "gemini-3-flash": { displayName: " Gemini 3 Flash ", quotaInfo: { resetTime: reset } },
        "gemini-3-pro": { quotaInfo: { remainingFraction: 1 } },
        "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0.5, resetTime: reset } },
        "gpt-oss-120b-medium": {},
        chat_20706: { quotaInfo: { remainingFraction: 1 } },
        chat_23310: { quotaInfo: { remainingFraction: 1 } },
        tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
        tab_jump_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
      },
    },
    "pro",
    NOW,
  );
  assert.equal(limits.plan, "pro");
  assert.equal(limits.fetchedAt, new Date(NOW).toISOString());
  assert.deepEqual(limits.windows, [
    { scope: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", usedPercent: 75, windowSeconds: 0, resetsAt: reset, limitReached: false },
    { scope: "gemini-2.5-pro", label: "Gemini 2.5 Pro", usedPercent: 50, windowSeconds: 0, resetsAt: reset, limitReached: false },
    { scope: "gemini-3-flash", label: "Gemini 3 Flash", usedPercent: 100, windowSeconds: 0, resetsAt: reset, limitReached: true },
    { scope: "gemini-3-pro", label: "gemini-3-pro", usedPercent: 0, windowSeconds: 0, resetsAt: null, limitReached: false },
  ]);
});

test("the models call posts the project and reports the status", async () => {
  respondWith(() => Response.json({ models: { a: {} } }));
  const ok = await fetchAvailableModels({ key: "tok", headers: {}, project: "proj-1" });
  assert.equal(ok.status, 200);
  assert.equal(calls[0]!.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
  assert.deepEqual(JSON.parse(calls[0]!.body), { project: "proj-1" });
  assert.equal(calls[0]!.headers.Authorization, "Bearer tok");
  assert.match(calls[0]!.headers["User-Agent"] ?? "", /^antigravity\//);
  respondWith(() => new Response("no", { status: 403 }));
  assert.deepEqual(await fetchAvailableModels({ key: "tok", headers: {}, project: "p" }, "https://example.test/"), { status: 403, json: null, retryAfter: null });
  assert.equal(calls[1]!.url, "https://example.test/v1internal:fetchAvailableModels");
  globalThis.fetch = (async () => {
    throw new Error("down");
  }) as typeof fetch;
  assert.equal((await fetchAvailableModels({ key: "tok", headers: {} })).status, 0);
});

test("antigravity deployments belong to the subscription pool and use the streaming endpoint", async () => {
  const { joinPath, prepareBody, upstreamHeaders } = await import("@/lib/gateway/dispatch/upstream");
  const { signInHeaders } = await import("@/lib/gateway/upstreams/credentials");
  assert.equal(routePool({ kind: "antigravity" }), "subscription");
  assert.equal(routePool({ kind: "openai", provider: { kind: "antigravity", internal: false } }), "subscription");
  assert.equal(joinPath(dep, "/chat/completions"), "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  assert.throws(() => joinPath(dep, "/embeddings"), (err: unknown) => err instanceof GateError && err.status === 400);
  const headers = upstreamHeaders(dep, {
    key: "tok",
    headers: signInHeaders("antigravity", { access: "tok", refresh: "r", accountId: "proj-1", residency: "" }),
  });
  assert.equal(headers.Authorization, "Bearer tok");
  assert.match(headers["User-Agent"] ?? "", /^antigravity\/hub\//);
  const body = prepareBody(dep, "/chat/completions", { model: "alias", messages: [{ role: "user", content: "x" }] });
  assert.equal(body.model, "claude-sonnet-4-6");
  assert.ok(Array.isArray((body.request as JsonMap).contents));
});

test("a chat request goes out as a Cloud Code envelope and the SSE reply returns as a chat completion", async () => {
  const { proxyJson } = await import("@/lib/gateway/dispatch/upstream");
  const { signInHeaders } = await import("@/lib/gateway/upstreams/credentials");
  respondWith(
    () =>
      new Response(
        sse(chunk({ content: { role: "model", parts: [{ text: "Pong" }] }, finishReason: "STOP" }, { promptTokenCount: 3, candidatesTokenCount: 1 })),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  const result = await proxyJson({
    dep,
    auth: { key: "tok", headers: signInHeaders("antigravity", { access: "tok", refresh: "r", accountId: "proj-1", residency: "" }), project: "proj-1" },
    path: "/chat/completions",
    body: { model: "alias", messages: [{ role: "user", content: "Ping" }], stream: false },
  });
  assert.equal(result.status, 200);
  assert.equal(calls[0]!.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  const sent = JSON.parse(calls[0]!.body) as JsonMap;
  assert.equal(sent.project, "proj-1");
  assert.equal(sent.model, "claude-sonnet-4-6");
  assert.equal(sent.userAgent, "antigravity");
  assert.deepEqual((sent.request as JsonMap).contents, [{ role: "user", parts: [{ text: "Ping" }] }]);
  assert.equal(calls[0]!.headers.Authorization, "Bearer tok");
  const json = result.json as JsonMap;
  assert.equal(((json.choices as JsonMap[])[0]!.message as JsonMap).content, "Pong");
  assert.equal((json.usage as JsonMap).prompt_tokens, 3);
});

test("a rate limited reply keeps Google's message and reset time", async () => {
  const { proxyJson, upstreamError } = await import("@/lib/gateway/dispatch/upstream");
  respondWith(
    () =>
      Response.json(
        { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota will reset after 8s", details: [{ metadata: { quotaResetDelay: "8s" } }] } },
        { status: 429 },
      ),
  );
  const result = await proxyJson({
    dep,
    auth: { key: "tok", headers: {}, project: "p" },
    path: "/chat/completions",
    body: { model: "alias", messages: [{ role: "user", content: "x" }] },
  });
  assert.equal(result.status, 429);
  const error = upstreamError(result.status, result.json, result.headers);
  assert.equal(error.message, "quota will reset after 8s");
  assert.ok(error.retryAt !== null && error.retryAt > Date.now());
});

test("the authorization link carries PKCE, offline access, and the loopback redirect", async () => {
  const { requestAntigravityAuthorization } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  const device = requestAntigravityAuthorization();
  const url = new URL(device.verificationUrl);
  assert.equal(`${url.origin}${url.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), ANTIGRAVITY_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), ANTIGRAVITY_REDIRECT_URI);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.match(url.searchParams.get("scope") ?? "", /auth\/cloud-platform/);
  assert.equal(device.grant.kind, "antigravity");
  assert.equal(url.searchParams.get("state"), "state" in device.grant ? device.grant.state : null);
  const challenge = url.searchParams.get("code_challenge");
  const { createHash } = await import("node:crypto");
  const verifier = "verifier" in device.grant ? device.grant.verifier : "";
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("without a saved or bundled client secret, Antigravity sign-in answers not configured", async () => {
  const { startAuthorization } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  await assert.rejects(startAuthorization("antigravity"), /ANTIGRAVITY_NOT_CONFIGURED/);
  configure("client-secret");
  const device = await startAuthorization("antigravity");
  assert.equal(device.grant.kind, "antigravity");
  const claude = await startAuthorization("claude");
  assert.equal(claude.grant.kind, "claude");
});

test("the client secret is stored sealed and read back", async () => {
  const { saveAntigravityClientSecret, antigravityClientSecret, antigravityClientState } = await import(
    "@/lib/gateway/upstreams/antigravity-config"
  );
  assert.equal(await antigravityClientSecret(), "");
  assert.deepEqual(await antigravityClientState(), { saved: false, bundled: false });
  await saveAntigravityClientSecret("test-client-secret");
  assert.doesNotMatch(settings.get(ENTERPRISE_KEY) ?? "", /test-client-secret/);
  assert.equal(await antigravityClientSecret(), "test-client-secret");
  assert.deepEqual(await antigravityClientState(), { saved: true, bundled: false });
  await saveAntigravityClientSecret("");
  assert.equal(await antigravityClientSecret(), "");
  assert.deepEqual(await antigravityClientState(), { saved: false, bundled: false });
});

function googleFlow(loaded: JsonMap, onboard?: JsonMap) {
  respondWith((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) return Response.json({ email: "dev@example.com" });
    if (url.endsWith(":loadCodeAssist")) return Response.json(loaded);
    if (url.endsWith(":onboardUser")) return Response.json(onboard ?? { done: true });
    return new Response("unexpected", { status: 500 });
  });
}

test("signing in exchanges the code, reads the email, and stores the Cloud Code project", async () => {
  const { requestAntigravityAuthorization, completeAuthorization } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  configure("client-secret");
  googleFlow({ cloudaicompanionProject: "proj-9", paidTier: { id: "g1-pro-tier" } });
  const device = requestAntigravityAuthorization();
  assert.equal(device.grant.kind, "antigravity");
  if (device.grant.kind !== "antigravity") return;
  const session = await completeAuthorization(
    device.grant,
    `${ANTIGRAVITY_REDIRECT_URI}?state=${device.grant.state}&code=4%2Fabc`,
  );
  assert.deepEqual(session.tokens, { access: "access-1", refresh: "refresh-1", accountId: "proj-9", residency: "" });
  assert.equal(session.account, "dev@example.com");
  assert.equal(session.plan, "pro");
  assert.ok(session.expiresAt > Date.now());
  const exchange = calls.find((call) => call.url.startsWith("https://oauth2.googleapis.com/token"))!;
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "4/abc");
  assert.equal(form.get("client_secret"), "client-secret");
  assert.equal(form.get("client_id"), ANTIGRAVITY_CLIENT_ID);
  assert.equal(form.get("redirect_uri"), ANTIGRAVITY_REDIRECT_URI);
  assert.equal(form.get("code_verifier"), device.grant.verifier);
  const load = calls.find((call) => call.url.endsWith(":loadCodeAssist"))!;
  assert.equal(load.url, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
  assert.deepEqual(JSON.parse(load.body), { metadata: { ideType: "ANTIGRAVITY" } });
  assert.equal(load.headers.Authorization, "Bearer access-1");
});

test("an account without a project is onboarded before it is stored", async () => {
  const { requestAntigravityAuthorization, completeAuthorization } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  configure("client-secret");
  googleFlow(
    { currentTier: { id: "free-tier" }, allowedTiers: [{ id: "free-tier", isDefault: true }] },
    { done: true, response: { cloudaicompanionProject: { id: "proj-new" } } },
  );
  const device = requestAntigravityAuthorization();
  if (device.grant.kind !== "antigravity") throw new Error("kind");
  const session = await completeAuthorization(device.grant, "4/code");
  assert.equal(session.tokens.accountId, "proj-new");
  assert.equal(session.plan, "free");
  const onboard = calls.find((call) => call.url.endsWith(":onboardUser"))!;
  assert.deepEqual(JSON.parse(onboard.body), { tierId: "free-tier", metadata: { ideType: "ANTIGRAVITY" } });
});

test("an account Google gives no project fails with a clear code", async () => {
  const { requestAntigravityAuthorization, completeAuthorization } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  configure("client-secret");
  googleFlow({ currentTier: { id: "free-tier" } }, { done: true });
  const device = requestAntigravityAuthorization();
  if (device.grant.kind !== "antigravity") throw new Error("kind");
  await assert.rejects(completeAuthorization(device.grant, "4/code"), /ANTIGRAVITY_NO_PROJECT/);
});

test("a wrong state, a missing code, or a missing secret stop the sign-in", async () => {
  const { requestAntigravityAuthorization, completeAuthorization } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  googleFlow({ cloudaicompanionProject: "p" });
  const device = requestAntigravityAuthorization();
  if (device.grant.kind !== "antigravity") throw new Error("kind");
  configure("client-secret");
  await assert.rejects(completeAuthorization(device.grant, `${ANTIGRAVITY_REDIRECT_URI}?state=other&code=x`), /SIGN_IN_FAILED/);
  await assert.rejects(completeAuthorization(device.grant, ""), /SIGN_IN_FAILED/);
  settings.clear();
  await assert.rejects(completeAuthorization(device.grant, "4/code"), /ANTIGRAVITY_NOT_CONFIGURED/);
  configure("client-secret");
  respondWith(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await assert.rejects(completeAuthorization(device.grant, "4/code"), /SIGN_IN_FAILED/);
});

test("refreshing keeps the project, account, and plan and replaces the access token", async () => {
  const { refreshSession } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  configure("client-secret");
  respondWith(() => Response.json({ access_token: "access-2", expires_in: 3600 }));
  const current: SignInSession = {
    tokens: { access: "access-1", refresh: "refresh-1", accountId: "proj-9", residency: "" },
    expiresAt: Date.now() - 1000,
    account: "dev@example.com",
    plan: "pro",
  };
  const outcome = await refreshSession("antigravity", current);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.session.tokens, { access: "access-2", refresh: "refresh-1", accountId: "proj-9", residency: "" });
  assert.equal(outcome.session.account, "dev@example.com");
  assert.equal(outcome.session.plan, "pro");
  const form = new URLSearchParams(calls[0]!.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "refresh-1");
  assert.equal(form.get("client_secret"), "client-secret");
  respondWith(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  assert.deepEqual(await refreshSession("antigravity", current), { ok: false, fatal: true, retryAfterMs: null });
});
