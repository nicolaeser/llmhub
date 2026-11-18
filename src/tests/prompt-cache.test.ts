import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  chatToAnthropic,
  MAX_CACHE_BREAKPOINTS,
  withCacheBreakpoints,
  withinCacheBreakpointLimit,
} from "@/lib/gateway/protocols/anthropic";
import { messagesToChat } from "@/lib/gateway/protocols/messages";
import { responsesToChat } from "@/lib/gateway/protocols/responses";
import { googlePayload, googleResponse } from "@/lib/gateway/upstreams/google";
import { chatToCodex, codexCompletion } from "@/lib/gateway/upstreams/codex";
import { chatToMuse } from "@/lib/gateway/upstreams/muse";
import { kimiChatBody } from "@/lib/gateway/upstreams/kimi";
import { promptCacheHeaders, withOpenRouterClaudeCache, XAI_CONVERSATION_HEADER } from "@/lib/gateway/upstreams/prompt-cache";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { usageFromUnknown } from "@/lib/gateway/billing/billing";
import { cacheReadRate, costOf } from "@/lib/gateway/billing/cost";
import type { MessagesRequest } from "@/types/anthropic";
import type { ResponsesRequest } from "@/types/responses";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";

(globalThis as { prisma?: unknown }).prisma = {};

const EPHEMERAL = { type: "ephemeral" };
const VERTEX_BASE = "https://aiplatform.googleapis.com/v1/projects/hub-test/locations/global";
const SYSTEM = "You are the stream host. ".repeat(40);

function deployment(kind: string, model: string, baseUrl = ""): ResolvedDeployment {
  return {
    id: `dep-${kind}-${model}`,
    kind,
    base_url: baseUrl,
    model,
    weight: 1,
    cost_input_per_1k: 0.001,
    cost_output_per_1k: 0.002,
    provider_id: `prov-${kind}`,
    provider: {
      id: `prov-${kind}`,
      kind,
      baseUrl,
      apiKey: "",
      zdr: false,
      retentionDays: null,
      region: "",
      noTraining: false,
      enabled: true,
      restricted: false,
    } as ResolvedDeployment["provider"],
  };
}

function chatBody(extra: JsonMap = {}): JsonMap {
  return {
    model: "alias",
    prompt_cache_key: "chan1:HOST",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    ...extra,
  };
}

function streamerBody(): JsonMap {
  return {
    model: "alias",
    prompt_cache_key: "chan1:HOST",
    messages: [
      { role: "system", content: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }] },
      {
        role: "user",
        content: [
          { type: "text", text: "stable head", cache_control: EPHEMERAL },
          { type: "text", text: "volatile tail" },
        ],
      },
    ],
  };
}

function markers(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + markers(item), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce(
    (sum: number, [key, item]) => sum + (key === "cache_control" ? 1 : markers(item)),
    0,
  );
}

function lastBlock(message: unknown): JsonMap {
  return ((message as JsonMap).content as JsonMap[]).at(-1)!;
}

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit | undefined }[] = [];

function respondWith(handler: () => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler();
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("Anthropic API keys get the same automatic breakpoints as the Claude subscription on converted chats", async () => {
  const { prepareBody } = await import("@/lib/gateway/dispatch/upstream");
  for (const kind of ["anthropic", "claude"]) {
    const sent = prepareBody(deployment(kind, "claude-haiku-5-5"), "/chat/completions", chatBody());
    const system = sent.system as JsonMap[];
    assert.deepEqual(system.at(-1)!.cache_control, EPHEMERAL, kind);
    assert.deepEqual((sent.tools as JsonMap[]).at(-1)!.cache_control, EPHEMERAL, kind);
    assert.deepEqual(lastBlock((sent.messages as JsonMap[]).at(-1)).cache_control, EPHEMERAL, kind);
    assert.equal(markers(sent), 3, kind);
  }
});

test("client cache markers on converted chats pass through unchanged on both Anthropic kinds", async () => {
  const { prepareBody } = await import("@/lib/gateway/dispatch/upstream");
  for (const kind of ["anthropic", "claude"]) {
    const sent = prepareBody(deployment(kind, "claude-haiku-5-5"), "/chat/completions", streamerBody());
    const system = sent.system as JsonMap[];
    assert.deepEqual(system.at(-1), { type: "text", text: SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }, kind);
    const user = (sent.messages as JsonMap[])[0]!.content as JsonMap[];
    assert.deepEqual(user[0]!.cache_control, EPHEMERAL, kind);
    assert.equal(user[1]!.cache_control, undefined, kind);
    assert.equal(markers(sent), 2, kind);
  }
});

test("more than four client breakpoints keep the first one and the latest three", () => {
  const blocks = Array.from({ length: 6 }, (_, index) => ({ type: "text", text: `part ${index}`, cache_control: EPHEMERAL }));
  const trimmed = withinCacheBreakpointLimit({
    model: "claude-haiku-5-5",
    system: blocks.slice(0, 2),
    messages: [{ role: "user", content: blocks.slice(2) }],
  });
  assert.equal(markers(trimmed), MAX_CACHE_BREAKPOINTS);
  const system = trimmed.system as JsonMap[];
  assert.deepEqual(system[0]!.cache_control, EPHEMERAL);
  assert.equal(system[1]!.cache_control, undefined);
  const user = (trimmed.messages as JsonMap[])[0]!.content as JsonMap[];
  assert.equal(user[0]!.cache_control, undefined);
  assert.deepEqual(
    user.slice(1).map((block) => block.cache_control),
    [EPHEMERAL, EPHEMERAL, EPHEMERAL],
  );
  const automatic = withinCacheBreakpointLimit({
    model: "claude-haiku-5-5",
    cache_control: EPHEMERAL,
    system: blocks.slice(0, 2),
    messages: [{ role: "user", content: blocks.slice(2) }],
  });
  assert.equal(markers(automatic), MAX_CACHE_BREAKPOINTS);
  const withinLimit = { model: "claude-haiku-5-5", system: blocks.slice(0, 2) };
  assert.equal(withinCacheBreakpointLimit(withinLimit), withinLimit);
});

test("breakpoints inside tool results count toward the limit", () => {
  const result = (id: string) => ({
    type: "tool_result",
    tool_use_id: id,
    content: [{ type: "text", text: id, cache_control: EPHEMERAL }],
    cache_control: EPHEMERAL,
  });
  const trimmed = withinCacheBreakpointLimit({
    model: "claude-haiku-5-5",
    messages: [{ role: "user", content: [result("a"), result("b"), result("c")] }],
  });
  assert.equal(markers(trimmed), MAX_CACHE_BREAKPOINTS);
  const content = (trimmed.messages as JsonMap[])[0]!.content as JsonMap[];
  assert.deepEqual(((content[0]!.content as JsonMap[])[0] as JsonMap).cache_control, EPHEMERAL);
  assert.deepEqual(content[2]!.cache_control, EPHEMERAL);
});

test("native Messages requests keep their own caching choice and only lose breakpoints beyond four", async () => {
  const { prepareBody } = await import("@/lib/gateway/dispatch/upstream");
  const plain = {
    model: "claude-haiku-5-5",
    max_tokens: 64,
    system: SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  assert.equal(markers(prepareBody(deployment("anthropic", "claude-haiku-5-5"), "/v1/messages", plain)), 0);
  const crowded = {
    ...plain,
    messages: [
      {
        role: "user",
        content: Array.from({ length: 5 }, (_, index) => ({ type: "text", text: `t${index}`, cache_control: EPHEMERAL })),
      },
    ],
  };
  for (const kind of ["anthropic", "claude"]) {
    assert.equal(markers(prepareBody(deployment(kind, "claude-haiku-5-5"), "/v1/messages", crowded)), MAX_CACHE_BREAKPOINTS, kind);
  }
});

test("automatic breakpoints skip empty text and thinking blocks", () => {
  const marked = withCacheBreakpoints({
    model: "claude-haiku-5-5",
    system: [
      { type: "text", text: SYSTEM },
      { type: "text", text: "" },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "" }] },
    ],
  });
  assert.deepEqual((marked.system as JsonMap[])[0]!.cache_control, EPHEMERAL);
  assert.equal((marked.system as JsonMap[])[1]!.cache_control, undefined);
  const content = (marked.messages as JsonMap[])[0]!.content as JsonMap[];
  assert.deepEqual(content[0]!.cache_control, EPHEMERAL);
  assert.equal(content[1]!.cache_control, undefined);
});

test("Vertex Claude gets automatic breakpoints and keeps client markers", () => {
  const vertex = googlePayload("vertex", "/chat/completions", { ...chatBody(), model: "claude-haiku-5-5" });
  assert.equal(markers(vertex), 3);
  assert.deepEqual((vertex.system as JsonMap[]).at(-1)!.cache_control, EPHEMERAL);
  const own = googlePayload("vertex", "/chat/completions", { ...streamerBody(), model: "claude-haiku-5-5" });
  assert.equal(markers(own), 2);
  assert.deepEqual((own.system as JsonMap[]).at(-1)!.cache_control, { type: "ephemeral", ttl: "1h" });
  const gemini = googlePayload("vertex", "/chat/completions", { ...chatBody(), model: "gemini-2.5-pro" });
  assert.equal(markers(gemini), 0);
});

test("a Messages request routed to Vertex Claude through the chat fallback is cached again", async () => {
  const { prepareBody } = await import("@/lib/gateway/dispatch/upstream");
  const request = {
    model: "claude-haiku-5-5",
    max_tokens: 64,
    system: [{ type: "text", text: SYSTEM, cache_control: EPHEMERAL }],
    metadata: { user_id: "user_abc_account__session_7f1c2a3b" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  } as unknown as MessagesRequest;
  const chat = messagesToChat(request);
  assert.equal(chat.prompt_cache_key, "claude-code-7f1c2a3b");
  const sent = prepareBody(deployment("vertex", "claude-haiku-5-5", VERTEX_BASE), "/chat/completions", chat);
  assert.deepEqual((sent.system as JsonMap[]).at(-1)!.cache_control, EPHEMERAL);
  assert.deepEqual(lastBlock((sent.messages as JsonMap[]).at(-1)).cache_control, EPHEMERAL);
});

test("OpenRouter Claude turns on automatic caching unless the client placed markers", async () => {
  const { prepareBody } = await import("@/lib/gateway/dispatch/upstream");
  for (const kind of ["openrouter", "openrouter_eu"]) {
    const sent = prepareBody(deployment(kind, "anthropic/claude-haiku-5.5"), "/chat/completions", chatBody());
    assert.deepEqual(sent.cache_control, EPHEMERAL, kind);
    assert.equal(sent.prompt_cache_key, "chan1:HOST", kind);
    const own = prepareBody(deployment(kind, "~anthropic/claude-sonnet-latest"), "/chat/completions", streamerBody());
    assert.equal(own.cache_control, undefined, kind);
    assert.equal(markers(own), 2, kind);
  }
  const gpt = prepareBody(deployment("openrouter", "openai/gpt-5.6"), "/chat/completions", chatBody());
  assert.equal(gpt.cache_control, undefined);
  assert.equal(gpt.prompt_cache_key, "chan1:HOST");
  assert.equal(withOpenRouterClaudeCache("openai", { model: "claude-haiku-5-5" }).cache_control, undefined);
  const embeddings = prepareBody(deployment("openrouter", "anthropic/claude-haiku-5.5"), "/embeddings", { model: "x", input: "a" });
  assert.equal(embeddings.cache_control, undefined);
});

test("OpenAI-style upstreams keep prompt_cache_key and gain no Anthropic markers", async () => {
  const { prepareBody } = await import("@/lib/gateway/dispatch/upstream");
  for (const kind of ["openai", "xai", "grok_build", "openai_compat", "typesafe", "moonshot", "moonshot_cn", "kimi", "kimi_ai"]) {
    const sent = prepareBody(deployment(kind, "model-x"), "/chat/completions", chatBody());
    assert.equal(sent.prompt_cache_key, "chan1:HOST", kind);
    assert.equal(markers(sent), 0, kind);
  }
  assert.equal(kimiChatBody(chatBody(), "moonshot").prompt_cache_key, "chan1:HOST");
  assert.equal(chatToCodex(chatBody()).prompt_cache_key, "chan1:HOST");
  assert.equal(chatToMuse(chatBody()).prompt_cache_key, "chan1:HOST");
});

test("xAI and Grok Build chats carry the cache key as x-grok-conv-id", () => {
  for (const kind of ["xai", "grok_build"]) {
    assert.deepEqual(promptCacheHeaders(kind, { prompt_cache_key: " chan1:HOST " }), { [XAI_CONVERSATION_HEADER]: "chan1:HOST" });
    assert.deepEqual(promptCacheHeaders(kind, {}), {});
  }
  for (const kind of ["openai", "openrouter", "claude", "anthropic", "moonshot"]) {
    assert.deepEqual(promptCacheHeaders(kind, { prompt_cache_key: "chan1:HOST" }), {}, kind);
  }
});

test("an xAI chat sends x-grok-conv-id upstream, also for Responses and Messages clients", async () => {
  const { proxyJson } = await import("@/lib/gateway/dispatch/upstream");
  respondWith(
    () =>
      new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 8051, completion_tokens: 3, total_tokens: 8054, prompt_tokens_details: { cached_tokens: 7936 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const responses = responsesToChat(
    { model: "grok-4.7", input: "hi", prompt_cache_key: "resp-key" } as unknown as ResponsesRequest,
    [],
  ).body;
  const messages = messagesToChat({
    model: "grok-4.7",
    max_tokens: 16,
    metadata: { user_id: "user_abc_account__session_4242abcd" },
    messages: [{ role: "user", content: "hi" }],
  } as unknown as MessagesRequest);
  const bodies: [JsonMap, string][] = [
    [chatBody(), "chan1:HOST"],
    [responses, "resp-key"],
    [messages, "claude-code-4242abcd"],
  ];
  for (const [body, key] of bodies) {
    calls = [];
    const result = await proxyJson({
      dep: deployment("xai", "grok-4.7", "https://api.x.ai/v1"),
      auth: { key: "xai-test", headers: {} },
      path: "/chat/completions",
      body,
    });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers[XAI_CONVERSATION_HEADER], key);
    assert.equal(JSON.parse(String(calls[0]!.init?.body)).prompt_cache_key, key);
    assert.equal(usageFromUnknown((result.json as JsonMap).usage).cache_read_input_tokens, 7936);
  }
});

test("an Anthropic API chat goes out with breakpoints and reports cache reads and writes", async () => {
  const { proxyJson } = await import("@/lib/gateway/dispatch/upstream");
  respondWith(
    () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 16, output_tokens: 4, cache_read_input_tokens: 14025, cache_creation_input_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const result = await proxyJson({
    dep: deployment("anthropic", "claude-haiku-5-5", "https://api.anthropic.com"),
    auth: { key: "sk-ant-test", headers: {} },
    path: "/chat/completions",
    body: chatBody(),
  });
  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(markers(JSON.parse(String(calls[0]!.init?.body))), 3);
  const usage = usageFromUnknown((result.json as JsonMap).usage);
  assert.equal(usage.prompt_tokens, 14041);
  assert.equal(usage.cache_read_input_tokens, 14025);
});

test("cached tokens from Gemini, Codex, and Kimi land in usage", () => {
  const gemini = googleResponse(
    "gemini",
    "/chat/completions",
    "gemini-2.5-flash",
    `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 8000, cachedContentTokenCount: 7000, candidatesTokenCount: 2, totalTokenCount: 8002 },
    })}\n\n`,
    {},
  ) as JsonMap;
  assert.equal(usageFromUnknown(gemini.usage).cache_read_input_tokens, 7000);
  const codex = codexCompletion(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
        usage: { input_tokens: 9000, output_tokens: 2, total_tokens: 9002, input_tokens_details: { cached_tokens: 8800 } },
      },
    })}\n\n`,
    "gpt-5.6",
  ) as JsonMap;
  assert.equal(usageFromUnknown(codex.usage).cache_read_input_tokens, 8800);
  const kimiNested = usageFromUnknown({ prompt_tokens: 1113, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1024 } });
  assert.equal(kimiNested.cache_read_input_tokens, 1024);
  const kimiFlat = usageFromUnknown({ prompt_tokens: 1113, completion_tokens: 5, total_tokens: 1118, cached_tokens: 1024 });
  assert.equal(kimiFlat.cache_read_input_tokens, 1024);
  assert.equal(kimiFlat.completion_tokens, 5);
});

test("cache reads are priced at each model family's published rate", () => {
  assert.equal(cacheReadRate("claude-haiku-5-5"), 0.1);
  assert.equal(cacheReadRate("claude-opus-5-5"), 0.05);
  assert.equal(cacheReadRate("anthropic/claude-sonnet-5.5"), 0.05);
  assert.equal(cacheReadRate("claude-fable-5-2"), 0.025);
  assert.equal(cacheReadRate("claude-mythos-5-1"), 0.025);
  assert.equal(cacheReadRate("claude-fable-5"), 0.1);
  assert.equal(cacheReadRate("grok-4.7"), 0.25);
  assert.equal(cacheReadRate("x-ai/grok-4-fast"), 0.25);
  assert.equal(cacheReadRate("grok-code-fast-1"), 0.1);
  assert.equal(cacheReadRate("kimi-k2-thinking"), 0.25);
  assert.equal(cacheReadRate("gpt-4.1-mini"), 0.25);
  assert.equal(cacheReadRate("o3"), 0.25);
  assert.equal(cacheReadRate("o3-mini"), 0.5);
  assert.equal(cacheReadRate("gpt-4o"), 0.5);
  assert.equal(cacheReadRate("gpt-5.6"), 0.1);
  assert.equal(cacheReadRate("gemini-3.1-pro"), 0.1);
  const usage = { prompt_tokens: 8000, completion_tokens: 0, cache_read_input_tokens: 6000 };
  const grok = costOf(deployment("xai", "grok-4.7"), usage);
  assert.ok(Math.abs(grok - (2000 * 0.000001 + 6000 * 0.000001 * 0.25)) < 1e-12);
});

test("every provider kind keeps a cache-keyed session on one account", async () => {
  const { pinsAccounts } = await import("@/lib/gateway/routing/account-affinity");
  for (const spec of PROVIDER_CATALOG) assert.equal(pinsAccounts(spec.kind), true, spec.kind);
  assert.equal(pinsAccounts("unknown_kind"), false);
});

test("chatToAnthropic keeps markers on tools, images, and files", () => {
  const native = chatToAnthropic({
    model: "claude-haiku-5-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" }, cache_control: EPHEMERAL },
          { type: "text", text: "describe" },
        ],
      },
    ],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } }, cache_control: EPHEMERAL }],
  });
  assert.equal(markers(native), 2);
  assert.equal(withCacheBreakpoints(native), native);
});
