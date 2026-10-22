import { API_KEY, gateway, gatewayRequest, groupRow, MODEL, resetGateway, UPSTREAM } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { digest, seal } from "@/lib/crypto";
import { prepareBody, upstreamAnthropicVersion, upstreamHeaders } from "@/lib/gateway/dispatch/upstream";
import { anthropicVersionParams } from "@/lib/gateway/protocols/anthropic-model-params";
import { anthropicPassthroughHeaders } from "@/lib/gateway/protocols/messages";
import { signInHeaders } from "@/lib/gateway/upstreams/credentials";
import { googleWire } from "@/lib/gateway/upstreams/google";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";

const V2023 = "2023-06-01";
const V2026 = "2026-10-21";
const SONNET_46 = "claude-sonnet-4-6";
const UPSTREAM_KEY = "sk-ant-upstream";
const CLAUDE_AUTH = { key: "sk-ant-oat01-a", headers: signInHeaders("claude", { access: "a", refresh: "r", accountId: "", residency: "" }) };

const CITATION = { type: "char_location", cited_text: "Paris", document_index: 0, start_char_index: 0, end_char_index: 5 };
const DOCUMENT = { type: "document", source: { type: "text", media_type: "text/plain", data: "Paris is the capital." } };
const SEARCH_RESULT = {
  type: "search_result",
  source: "https://example.test/paris",
  title: "Paris",
  citations: { enabled: true },
  content: [{ type: "text", text: "Paris is the capital.", citations: [CITATION] }],
};

type GatewayHandler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type AnthropicRoute = { name: string; method: "GET" | "POST"; path: string; params?: Record<string, string>; load: () => Promise<GatewayHandler> };

const ANTHROPIC_ROUTES: AnthropicRoute[] = [
  { name: "messages", method: "POST", path: "/api/v1/messages", load: async () => (await import("@/app/api/v1/messages/route")).POST },
  {
    name: "count_tokens",
    method: "POST",
    path: "/api/v1/messages/count_tokens",
    load: async () => (await import("@/app/api/v1/messages/count_tokens/route")).POST,
  },
  { name: "models", method: "GET", path: "/api/v1/models", load: async () => (await import("@/app/api/v1/models/route")).GET },
  {
    name: "model",
    method: "GET",
    path: `/api/v1/models/${MODEL}`,
    params: { id: MODEL },
    load: async () => (await import("@/app/api/v1/models/[id]/route")).GET as GatewayHandler,
  },
  {
    name: "subscription messages",
    method: "POST",
    path: "/api/subscription/v1/messages",
    load: async () => (await import("@/app/api/subscription/v1/messages/route")).POST,
  },
  {
    name: "subscription count_tokens",
    method: "POST",
    path: "/api/subscription/v1/messages/count_tokens",
    load: async () => (await import("@/app/api/subscription/v1/messages/count_tokens/route")).POST,
  },
  {
    name: "subscription models",
    method: "GET",
    path: "/api/subscription/v1/models",
    load: async () => (await import("@/app/api/subscription/v1/models/route")).GET,
  },
  {
    name: "subscription model",
    method: "GET",
    path: `/api/subscription/v1/models/${MODEL}`,
    params: { id: MODEL },
    load: async () => (await import("@/app/api/subscription/v1/models/[id]/route")).GET as GatewayHandler,
  },
];

const SDK_HEADER_SHAPES: Record<string, Record<string, string>> = {
  "Authorization: Bearer with 2026-10-21": { authorization: `Bearer ${API_KEY}`, "anthropic-version": V2026 },
  "x-api-key with 2023-06-01": { "x-api-key": API_KEY, "anthropic-version": V2023 },
  "both headers with 2026-10-21": { authorization: `Bearer ${API_KEY}`, "x-api-key": API_KEY, "anthropic-version": V2026 },
};

function presentedHashes(): string[] {
  return recordedPrisma.called("virtualKey", "findFirst").map((call) => {
    const where = (call.args as { where: { OR: { hash?: string }[] } }).where;
    return where.OR[0]?.hash ?? "";
  });
}

function onlyHubKey(): void {
  recordedPrisma.reset({
    virtualKey: {
      findFirst: (args: { where: { OR: { hash?: string }[] } }) => (args.where.OR[0]?.hash === digest(API_KEY) ? gateway.key : null),
    },
  });
}

async function callAnthropicRoute(route: AnthropicRoute, headers: Record<string, string>): Promise<Response> {
  const handler = await route.load();
  const body = route.method === "POST" ? JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Hi" }] }) : undefined;
  const req = new Request(`http://hub.local${route.path}`, {
    method: route.method,
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return handler(req, { params: Promise.resolve(route.params ?? {}) });
}

function deployment(kind: string, model = SONNET_46, baseUrl = UPSTREAM): ResolvedDeployment {
  return {
    id: `${kind}-route`,
    kind,
    base_url: baseUrl,
    model,
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: `${kind}-provider`,
  };
}

function clientHeaders(version?: string): Record<string, string> {
  const headers = new Headers({
    authorization: `Bearer ${API_KEY}`,
    "x-api-key": API_KEY,
    "anthropic-beta": "context-1m-2025-08-07",
    "user-agent": "Anthropic/JS 1.0.0",
    "x-stainless-lang": "js",
  });
  if (version) headers.set("anthropic-version", version);
  return anthropicPassthroughHeaders(headers);
}

function versionHeaders(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "anthropic-version")
    .map(([, value]) => value);
}

function legacyConversation(): JsonMap[] {
  return [
    { role: "user", content: [{ type: "text", text: "Paris is the capital.", citations: [CITATION] }] },
    { role: "assistant", content: [DOCUMENT, { type: "text", text: "Noted.", citations: [CITATION] }] },
    { role: "user", content: "Summarize it." },
  ];
}

function legacyBody(model = "alias"): JsonMap {
  return { model, max_tokens: 256, temperature: 0.2, top_p: 0.9, top_k: 40, messages: legacyConversation() };
}

test("new SDK header shapes authenticate the hub key on every Anthropic-format route", async () => {
  resetGateway();
  for (const route of ANTHROPIC_ROUTES) {
    for (const [shape, headers] of Object.entries(SDK_HEADER_SHAPES)) {
      onlyHubKey();
      const res = await callAnthropicRoute(route, headers);
      const label = `${route.name} ${shape}`;
      assert.notEqual(res.status, 401, label);
      assert.deepEqual(presentedHashes(), [digest(API_KEY)], label);
      if (!route.name.startsWith("subscription")) assert.equal(res.status, 200, `${label} ${await res.text()}`);
    }
  }
});

test("Authorization wins over x-api-key when the two carry different keys", async () => {
  resetGateway();
  const route = ANTHROPIC_ROUTES[0]!;
  onlyHubKey();
  const rejected = await callAnthropicRoute(route, { authorization: "Bearer sk-hub-other", "x-api-key": API_KEY, "anthropic-version": V2026 });
  assert.equal(rejected.status, 401);
  assert.equal(((await rejected.json()) as { error: { type: string } }).error.type, "authentication_error");
  onlyHubKey();
  const accepted = await callAnthropicRoute(route, { authorization: `Bearer ${API_KEY}`, "x-api-key": "sk-hub-other", "anthropic-version": V2026 });
  assert.equal(accepted.status, 200);
});

test("first-party Anthropic upstreams get the client's version and never an upgrade", () => {
  for (const kind of ["anthropic", "claude"]) {
    assert.equal(upstreamAnthropicVersion(deployment(kind)), V2023, kind);
    assert.equal(upstreamAnthropicVersion(deployment(kind), {}), V2023, kind);
    assert.equal(upstreamAnthropicVersion(deployment(kind), { "anthropic-version": V2023 }), V2023, kind);
    assert.equal(upstreamAnthropicVersion(deployment(kind), { "Anthropic-Version": ` ${V2026} ` }), V2026, kind);
    assert.equal(upstreamAnthropicVersion(deployment(kind), { "anthropic-version": "2027-03-01" }), "2027-03-01", kind);
  }
});

test("other upstreams never receive a version they cannot accept", () => {
  for (const kind of ["kimi", "kimi_ai"]) {
    assert.equal(upstreamAnthropicVersion(deployment(kind, "kimi-for-coding"), { "anthropic-version": V2026 }), V2023, kind);
    assert.equal(upstreamAnthropicVersion(deployment(kind, "kimi-for-coding")), null, kind);
  }
  for (const kind of ["openai", "openai_compat", "openrouter", "xai", "codex", "gemini", "vertex", "moonshot", "devin"]) {
    assert.equal(upstreamAnthropicVersion(deployment(kind), { "anthropic-version": V2026 }), null, kind);
  }
});

test("Bedrock models before Claude 4.7 stay on 2023-06-01", () => {
  const mantle = "https://bedrock-mantle.us-east-1.api.aws/anthropic";
  const asked = { "anthropic-version": V2026 };
  for (const model of ["anthropic.claude-haiku-4-5", "us.anthropic.claude-opus-4-6-v1:0", "anthropic.claude-3-7-sonnet-20250219-v1:0"]) {
    assert.equal(upstreamAnthropicVersion(deployment("anthropic", model), asked), V2023, model);
  }
  assert.equal(upstreamAnthropicVersion(deployment("anthropic", SONNET_46, mantle), asked), V2023);
  assert.equal(upstreamAnthropicVersion(deployment("anthropic", "", mantle), asked), V2023);
  for (const model of ["anthropic.claude-opus-4-7", "global.anthropic.claude-opus-5-5", "anthropic.claude-mythos-preview"]) {
    assert.equal(upstreamAnthropicVersion(deployment("anthropic", model), asked), V2026, model);
  }
  assert.equal(upstreamAnthropicVersion(deployment("anthropic", "claude-fable-5-1", mantle), asked), V2026);
  assert.equal(upstreamAnthropicVersion(deployment("anthropic", SONNET_46), asked), V2026);
});

test("upstream headers carry exactly one policy version and never the hub key", () => {
  const anthropic = upstreamHeaders(deployment("anthropic"), { key: UPSTREAM_KEY, headers: {} }, clientHeaders(V2026));
  assert.deepEqual(versionHeaders(anthropic), [V2026]);
  assert.equal(anthropic["x-api-key"], UPSTREAM_KEY);
  assert.equal(anthropic.Authorization ?? anthropic.authorization, undefined);
  assert.equal(anthropic["anthropic-beta"], "context-1m-2025-08-07");
  assert.equal(anthropic["x-stainless-lang"], "js");
  assert.deepEqual(versionHeaders(upstreamHeaders(deployment("anthropic"), { key: UPSTREAM_KEY, headers: {} })), [V2023]);

  const claude = upstreamHeaders(deployment("claude"), CLAUDE_AUTH, clientHeaders(V2026));
  assert.deepEqual(versionHeaders(claude), [V2026]);
  assert.equal(claude.Authorization, `Bearer ${CLAUDE_AUTH.key}`);
  assert.deepEqual(versionHeaders(upstreamHeaders(deployment("claude"), CLAUDE_AUTH)), [V2023]);
  assert.deepEqual(versionHeaders(upstreamHeaders(deployment("claude"), CLAUDE_AUTH, clientHeaders(V2023))), [V2023]);

  const kimi = upstreamHeaders(deployment("kimi", "kimi-for-coding"), { key: "sk-kimi", headers: {} }, clientHeaders(V2026));
  assert.deepEqual(versionHeaders(kimi), [V2023]);
  assert.equal(kimi["anthropic-beta"], "context-1m-2025-08-07");
  assert.equal(kimi["x-stainless-lang"], undefined);

  for (const kind of ["openai", "vertex", "openrouter"]) {
    const other = upstreamHeaders(deployment(kind), { key: "sk-other", headers: {} }, clientHeaders(V2026));
    assert.deepEqual(versionHeaders(other), [], kind);
    assert.equal(other["anthropic-beta"], undefined, kind);
    assert.equal(other.Authorization, "Bearer sk-other", kind);
  }
});

test("2026-10-21 bodies drop sampling parameters even at their defaults", () => {
  const result = anthropicVersionParams(V2026, { model: "m", max_tokens: 8, temperature: 1, top_p: 1, top_k: 0, messages: [] });
  for (const key of ["temperature", "top_p", "top_k"]) assert.equal(key in result.body, false, key);
  assert.deepEqual(result.adjustments, ["temperature:dropped", "top_p:dropped", "top_k:dropped"]);
});

test("2026-10-21 bodies move assistant documents into the user turn before them", () => {
  const result = anthropicVersionParams(V2026, { model: "m", max_tokens: 8, messages: legacyConversation().slice(1) });
  assert.deepEqual(result.body.messages, [
    { role: "user", content: [DOCUMENT] },
    { role: "assistant", content: [{ type: "text", text: "Noted.", citations: [CITATION] }] },
    { role: "user", content: "Summarize it." },
  ]);
  assert.deepEqual(result.adjustments, ["assistant_documents:moved"]);

  const merged = anthropicVersionParams(V2026, {
    messages: [
      { role: "user", content: "Read this." },
      { role: "assistant", content: [DOCUMENT] },
      { role: "user", content: "Done?" },
    ],
  });
  assert.deepEqual(merged.body.messages, [
    { role: "user", content: [{ type: "text", text: "Read this." }, DOCUMENT] },
    { role: "user", content: "Done?" },
  ]);

  const fetched = {
    type: "web_fetch_tool_result",
    tool_use_id: "srvtoolu_1",
    content: { type: "web_fetch_result", url: "https://example.test", content: DOCUMENT },
  };
  const nested = { messages: [{ role: "user", content: "Fetch it." }, { role: "assistant", content: [fetched] }] };
  const kept = anthropicVersionParams(V2026, nested);
  assert.equal(kept.body, nested);
  assert.deepEqual(kept.adjustments, []);
});

test("2026-10-21 bodies strip non-empty citations from user text, including search and tool results", () => {
  const toolResult = { type: "tool_result", tool_use_id: "toolu_1", content: [SEARCH_RESULT, { type: "text", text: "raw", citations: [CITATION] }] };
  const request = {
    messages: [
      {
        role: "user",
        content: [
          toolResult,
          { type: "text", text: "Quoted.", citations: [CITATION] },
          { type: "text", text: "Plain.", citations: [] },
          { ...DOCUMENT, citations: { enabled: true } },
          SEARCH_RESULT,
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Answer.", citations: [CITATION] }] },
    ],
  };
  const snapshot = structuredClone(request);
  const result = anthropicVersionParams(V2026, request);
  const plainSearch = { ...SEARCH_RESULT, content: [{ type: "text", text: "Paris is the capital." }] };
  assert.deepEqual(result.body.messages, [
    {
      role: "user",
      content: [
        { ...toolResult, content: [plainSearch, { type: "text", text: "raw" }] },
        { type: "text", text: "Quoted." },
        { type: "text", text: "Plain.", citations: [] },
        { ...DOCUMENT, citations: { enabled: true } },
        plainSearch,
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Answer.", citations: [CITATION] }] },
  ]);
  assert.deepEqual(result.adjustments, ["user_citations:dropped"]);
  assert.deepEqual(request, snapshot);
});

test("version rules apply from 2026-10-21 on and leave other versions untouched", () => {
  const request = legacyBody();
  for (const version of [null, "", V2023, "2026-10-20", "latest", "2026-10-21-beta"]) {
    const result = anthropicVersionParams(version, request);
    assert.equal(result.body, request, String(version));
    assert.deepEqual(result.adjustments, [], String(version));
  }
  const future = anthropicVersionParams("2027-01-15", request);
  assert.deepEqual(future.adjustments, [
    "temperature:dropped",
    "top_p:dropped",
    "top_k:dropped",
    "assistant_documents:moved",
    "user_citations:dropped",
  ]);
});

test("prepareBody fits native and count_tokens bodies to the outbound version", () => {
  for (const kind of ["anthropic", "claude"]) {
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const sent = prepareBody(deployment(kind), path, legacyBody(), "", clientHeaders(V2026));
      const label = `${kind} ${path}`;
      for (const key of ["temperature", "top_p", "top_k"]) assert.equal(key in sent, false, `${label} ${key}`);
      const messages = sent.messages as JsonMap[];
      assert.equal(messages.length, 3, label);
      assert.deepEqual(messages[0], { role: "user", content: [{ type: "text", text: "Paris is the capital." }, DOCUMENT] }, label);
      assert.deepEqual(messages[1]!.content, [{ type: "text", text: "Noted.", citations: [CITATION] }], label);

      const legacy = prepareBody(deployment(kind), path, legacyBody(), "", clientHeaders(V2023));
      assert.equal(legacy.temperature, 0.2, label);
      assert.deepEqual(legacy.messages, legacyConversation(), label);
      assert.equal(prepareBody(deployment(kind), path, legacyBody()).temperature, 0.2, label);
    }
  }
  const kimi = prepareBody(deployment("kimi", "kimi-for-coding"), "/v1/messages", legacyBody(), "", clientHeaders(V2026));
  assert.equal(kimi.temperature, 0.2);
  assert.deepEqual(kimi.messages, legacyConversation());
});

test("Vertex Claude keeps its body version and sampling regardless of the client header", () => {
  const vertex = deployment("vertex", SONNET_46, "https://aiplatform.googleapis.com/v1/projects/p-123456/locations/global");
  const chat = { model: "alias", temperature: 0.2, messages: [{ role: "user", content: "Hi" }] };
  const payload = prepareBody(vertex, "/chat/completions", chat, "", clientHeaders(V2026));
  assert.equal(payload.temperature, 0.2);
  const wire = googleWire("vertex", "/chat/completions", payload);
  assert.equal(wire.anthropic_version, "vertex-2023-10-16");
  assert.equal("model" in wire, false);
  assert.deepEqual(versionHeaders(upstreamHeaders(vertex, { key: "ya29.token", headers: {} }, clientHeaders(V2026))), []);
});

function anthropicRoute(model: string): JsonMap {
  return {
    id: `route-${model}`,
    kind: "anthropic",
    baseUrl: UPSTREAM,
    model,
    weight: 1,
    costInput: 0,
    costOutput: 0,
    providerId: `provider-${model}`,
    provider: {
      id: `provider-${model}`,
      kind: "anthropic",
      baseUrl: UPSTREAM,
      apiKey: seal(UPSTREAM_KEY),
      zdr: false,
      retentionDays: null,
      region: "",
      noTraining: false,
      enabled: true,
      restricted: false,
      assignments: [],
    },
  };
}

const ALIAS = "sonnet-46";

function anthropicMessage(): Response {
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: SONNET_46,
    content: [{ type: "text", text: "Paris." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  });
}

function sseEvent(event: string, data: JsonMap): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicStream(): Response {
  const events = [
    sseEvent("message_start", {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: SONNET_46, content: [], usage: { input_tokens: 3, output_tokens: 0 } },
    }),
    sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Paris." } }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    sseEvent("message_stop", { type: "message_stop" }),
  ];
  return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
}

function useAnthropicAlias(): void {
  resetGateway();
  gateway.groups.set(ALIAS, groupRow(ALIAS, { vendor: "anthropic", deployments: [anthropicRoute(SONNET_46)] }));
  gateway.reply = (call) => {
    if (call.url.endsWith("/count_tokens")) return Response.json({ input_tokens: 42 });
    return call.body?.stream === true ? anthropicStream() : anthropicMessage();
  };
}

const NEW_SDK = { "x-api-key": API_KEY, "anthropic-version": V2026, "anthropic-beta": "context-1m-2025-08-07" };

test("a 2026-10-21 Messages call reaches Anthropic with its version and a body that version accepts", async () => {
  useAnthropicAlias();
  const { POST } = await import("@/app/api/v1/messages/route");
  const res = await POST(gatewayRequest("/api/v1/messages", legacyBody(ALIAS), NEW_SDK));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as { model: string }).model, ALIAS);
  assert.equal(gateway.upstream.length, 1);
  const call = gateway.upstream[0]!;
  assert.match(call.url, /\/v1\/messages$/);
  assert.equal(call.headers["anthropic-version"], V2026);
  assert.equal(call.headers["anthropic-beta"], "context-1m-2025-08-07");
  assert.equal(call.headers["x-api-key"], UPSTREAM_KEY);
  assert.equal(call.headers.authorization, undefined);
  const sent = call.body!;
  assert.equal(sent.model, SONNET_46);
  for (const key of ["temperature", "top_p", "top_k"]) assert.equal(key in sent, false, key);
  const messages = sent.messages as JsonMap[];
  assert.deepEqual(messages[0], { role: "user", content: [{ type: "text", text: "Paris is the capital." }, DOCUMENT] });
  assert.equal((messages[1]!.content as JsonMap[]).some((block) => block.type === "document"), false);
});

test("a 2023-06-01 Messages call keeps its version, sampling, and documents", async () => {
  useAnthropicAlias();
  const { POST } = await import("@/app/api/v1/messages/route");
  const res = await POST(gatewayRequest("/api/v1/messages", legacyBody(ALIAS), { "anthropic-version": V2023 }));
  assert.equal(res.status, 200);
  const call = gateway.upstream[0]!;
  assert.equal(call.headers["anthropic-version"], V2023);
  assert.equal(call.body!.temperature, 0.2);
  assert.equal(call.body!.top_k, 40);
  assert.deepEqual(call.body!.messages, legacyConversation());
});

test("streamed 2026-10-21 Messages calls apply the same version rules", async () => {
  useAnthropicAlias();
  const { POST } = await import("@/app/api/v1/messages/route");
  const res = await POST(gatewayRequest("/api/v1/messages", { ...legacyBody(ALIAS), stream: true }, NEW_SDK));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Paris\./);
  const call = gateway.upstream[0]!;
  assert.equal(call.headers["anthropic-version"], V2026);
  assert.equal(call.body!.stream, true);
  assert.equal("temperature" in call.body!, false);
  assert.deepEqual((call.body!.messages as JsonMap[])[0], {
    role: "user",
    content: [{ type: "text", text: "Paris is the capital." }, DOCUMENT],
  });
});

test("count_tokens on 2026-10-21 sends the version and a body that version accepts", async () => {
  useAnthropicAlias();
  const { POST } = await import("@/app/api/v1/messages/count_tokens/route");
  const res = await POST(gatewayRequest("/api/v1/messages/count_tokens", legacyBody(ALIAS), NEW_SDK));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { input_tokens: 42 });
  const call = gateway.upstream[0]!;
  assert.match(call.url, /\/v1\/messages\/count_tokens$/);
  assert.equal(call.headers["anthropic-version"], V2026);
  assert.equal(call.headers["x-api-key"], UPSTREAM_KEY);
  assert.deepEqual((call.body!.messages as JsonMap[])[0], {
    role: "user",
    content: [{ type: "text", text: "Paris is the capital." }, DOCUMENT],
  });
});

test("a 2026-10-21 client routed to an OpenAI-style provider still gets a Messages answer", async () => {
  resetGateway();
  const { POST } = await import("@/app/api/v1/messages/route");
  const res = await POST(
    gatewayRequest("/api/v1/messages", { model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Hi" }] }, NEW_SDK),
  );
  assert.equal(res.status, 200);
  const message = (await res.json()) as { type: string; role: string; model: string; content: { type: string; text: string }[] };
  assert.equal(message.type, "message");
  assert.equal(message.role, "assistant");
  assert.equal(message.model, MODEL);
  assert.deepEqual(message.content, [{ type: "text", text: "ok" }]);
  const call = gateway.upstream[0]!;
  assert.match(call.url, /\/chat\/completions$/);
  assert.equal(call.headers["anthropic-version"], undefined);
  assert.equal(call.headers["anthropic-beta"], undefined);
});
