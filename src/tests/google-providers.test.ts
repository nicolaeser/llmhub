import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { GateError } from "@/lib/gateway/errors";
import {
  chatToGemini,
  geminiThinking,
  googlePayload,
  googleResponse,
  googleStreamTranslator,
  googleWire,
  imagenImages,
  imagenRequest,
} from "@/lib/gateway/upstreams/google";
import {
  serviceAccountSummary,
  vertexAspectRatio,
  vertexBaseUrl,
  vertexCredentialKind,
  vertexModelRoute,
  vertexTarget,
} from "@/lib/gateway/upstreams/vertex-target";
import { PROVIDER_CATALOG, speaksGoogle } from "@/lib/gateway/upstreams/provider-kinds";
import { snapshotNames, trustedKind, vendorOf } from "@/lib/gateway/catalog/model-catalog";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";

(globalThis as { prisma?: unknown }).prisma = {};

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const pkcs1 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const ecKey = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

function serviceAccountJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "hub-test-project",
    private_key_id: "key-1",
    private_key: privateKey,
    client_email: "hub@hub-test-project.iam.gserviceaccount.com",
    client_id: "1234567890",
    token_uri: "https://oauth2.googleapis.com/token",
    ...overrides,
  });
}

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit | undefined }[] = [];

function respondWith(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function deployment(kind: string, model: string, baseUrl: string): ResolvedDeployment {
  return {
    id: `dep-${kind}-${model}`,
    kind,
    base_url: "",
    model,
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
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

function sse(...events: JsonMap[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function anthropicSse(...events: [string, JsonMap][]): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const SA_BASE = "https://us-central1-aiplatform.googleapis.com/v1/projects/hub-test-project/locations/us-central1";
const GLOBAL_BASE = "https://aiplatform.googleapis.com/v1/projects/hub-test-project/locations/global";
const EXPRESS_BASE = "https://aiplatform.googleapis.com/v1";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

test("Gemini API and Vertex AI are API key kinds with Google defaults", () => {
  const gemini = PROVIDER_CATALOG.find((spec) => spec.kind === "gemini");
  const vertex = PROVIDER_CATALOG.find((spec) => spec.kind === "vertex");
  assert.deepEqual(gemini, { kind: "gemini", name: "Google Gemini API", default_base_url: GEMINI_BASE });
  assert.deepEqual(vertex, { kind: "vertex", name: "Google Vertex AI", default_base_url: EXPRESS_BASE });
  assert.equal(speaksGoogle("gemini") && speaksGoogle("vertex"), true);
  assert.equal(speaksGoogle("antigravity"), false);
});

test("Vertex locations pick the global, multi-region, or regional host", () => {
  assert.equal(vertexBaseUrl({ project: "hub-test-project", location: "global" }), GLOBAL_BASE);
  assert.equal(vertexBaseUrl({ project: "hub-test-project", location: "us-central1" }), SA_BASE);
  assert.equal(
    vertexBaseUrl({ project: "hub-test-project", location: "eu" }),
    "https://aiplatform.eu.rep.googleapis.com/v1/projects/hub-test-project/locations/eu",
  );
  assert.deepEqual(vertexTarget(SA_BASE), { project: "hub-test-project", location: "us-central1" });
  assert.deepEqual(vertexTarget(`${GLOBAL_BASE}/`), { project: "hub-test-project", location: "global" });
  assert.equal(vertexTarget(EXPRESS_BASE), null);
  assert.equal(vertexTarget("https://aiplatform.googleapis.com/v1/projects/x/locations/us-central1"), null);
});

test("Vertex model ids route to Gemini, Claude, or the OpenAI-compatible partner endpoint", () => {
  assert.deepEqual(vertexModelRoute("gemini-2.5-pro"), { route: "google", model: "gemini-2.5-pro" });
  assert.deepEqual(vertexModelRoute("publishers/google/models/gemini-2.5-flash"), { route: "google", model: "gemini-2.5-flash" });
  assert.deepEqual(vertexModelRoute("claude-sonnet-4-5@20250929"), { route: "anthropic", model: "claude-sonnet-4-5@20250929" });
  assert.deepEqual(vertexModelRoute("anthropic/claude-opus-4-1"), { route: "anthropic", model: "claude-opus-4-1" });
  assert.deepEqual(vertexModelRoute("meta/llama-4-maverick-17b-128e-instruct-maas"), {
    route: "openapi",
    model: "meta/llama-4-maverick-17b-128e-instruct-maas",
  });
  assert.deepEqual(vertexModelRoute("publishers/deepseek-ai/models/deepseek-v3.1-maas"), {
    route: "openapi",
    model: "deepseek-ai/deepseek-v3.1-maas",
  });
});

test("request URLs follow the kind, the model route, and the endpoint", async () => {
  const { joinPath } = await import("@/lib/gateway/dispatch/upstream");
  const gemini = deployment("gemini", "gemini-2.5-flash", GEMINI_BASE);
  assert.equal(
    joinPath(gemini, "/chat/completions"),
    `${GEMINI_BASE}/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
  );
  assert.equal(joinPath(gemini, "/embeddings"), `${GEMINI_BASE}/openai/embeddings`);
  assert.equal(joinPath(gemini, "/v1/images/generations"), `${GEMINI_BASE}/openai/images/generations`);
  assert.equal(joinPath(gemini, "/videos/vid_1/content"), `${GEMINI_BASE}/openai/videos/vid_1/content`);
  assert.equal(
    joinPath(deployment("gemini", "", "https://generativelanguage.googleapis.com/v1beta/openai/"), "/chat/completions", "models/gemini-3-pro-preview"),
    `${GEMINI_BASE}/models/gemini-3-pro-preview:streamGenerateContent?alt=sse`,
  );
  assert.throws(
    () => joinPath(gemini, "/audio/speech"),
    (err: unknown) => err instanceof GateError && err.status === 400 && err.code === "unsupported_endpoint",
  );
  assert.throws(
    () => joinPath(deployment("gemini", "../x", GEMINI_BASE), "/chat/completions"),
    (err: unknown) => err instanceof GateError && err.status === 400,
  );

  const vertex = (model: string, base = SA_BASE) => deployment("vertex", model, base);
  assert.equal(
    joinPath(vertex("gemini-2.5-pro"), "/chat/completions"),
    `${SA_BASE}/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse`,
  );
  assert.equal(
    joinPath(vertex("claude-sonnet-4-5@20250929", GLOBAL_BASE), "/chat/completions"),
    `${GLOBAL_BASE}/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict`,
  );
  assert.equal(
    joinPath(vertex("meta/llama-4-maverick-17b-128e-instruct-maas"), "/chat/completions"),
    `${SA_BASE}/endpoints/openapi/chat/completions`,
  );
  assert.equal(
    joinPath(vertex("imagen-4.0-generate-001"), "/images/generations"),
    `${SA_BASE}/publishers/google/models/imagen-4.0-generate-001:predict`,
  );
  assert.equal(
    joinPath(vertex("gemini-2.5-flash", EXPRESS_BASE), "/chat/completions"),
    `${EXPRESS_BASE}/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
  );
  const needsProject = (err: unknown) => err instanceof GateError && err.status === 400 && /service account/.test(err.message);
  assert.throws(() => joinPath(vertex("claude-sonnet-4-5", EXPRESS_BASE), "/chat/completions"), needsProject);
  assert.throws(() => joinPath(vertex("imagen-4.0-generate-001", EXPRESS_BASE), "/images/generations"), needsProject);
  assert.throws(
    () => joinPath(vertex("gemini-2.5-pro"), "/images/generations"),
    (err: unknown) => err instanceof GateError && err.status === 400,
  );
  assert.throws(
    () => joinPath(vertex("gemini-2.5-pro"), "/embeddings"),
    (err: unknown) => err instanceof GateError && err.code === "unsupported_endpoint",
  );
});

test("Gemini API keys go in x-goog-api-key and service account tokens as a bearer", async () => {
  const { upstreamHeaders } = await import("@/lib/gateway/dispatch/upstream");
  const gemini = upstreamHeaders(deployment("gemini", "gemini-2.5-flash", GEMINI_BASE), {
    key: "AIzaTest",
    headers: {},
    keyHeader: "x-goog-api-key",
  });
  assert.equal(gemini["x-goog-api-key"], "AIzaTest");
  assert.equal(gemini.Authorization, undefined);
  const vertex = upstreamHeaders(deployment("vertex", "gemini-2.5-flash", SA_BASE), { key: "ya29.token", headers: {} });
  assert.equal(vertex.Authorization, "Bearer ya29.token");
  assert.equal(vertex["x-goog-api-key"], undefined);
});

test("chat requests become Gemini contents with system, tools, media, and settings", () => {
  const converted = chatToGemini("gemini", {
    model: "models/gemini-2.5-flash",
    messages: [
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          { type: "input_audio", input_audio: { data: "UklGRg==", format: "mp3" } },
          { type: "file", file: { file_data: "data:application/pdf;base64,JVBERi0=" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "found" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look up",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false },
        },
      },
    ],
    tool_choice: "required",
    temperature: 0.3,
    top_k: 20,
    max_tokens: 900,
    seed: 7,
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
    stop: ["END"],
  });
  assert.equal(converted.model, "gemini-2.5-flash");
  const request = converted.request as JsonMap;
  assert.deepEqual(request.systemInstruction, { role: "user", parts: [{ text: "Be brief." }] });
  const contents = request.contents as JsonMap[];
  assert.deepEqual(contents[0], {
    role: "user",
    parts: [
      { text: "Describe" },
      { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
      { inlineData: { mimeType: "audio/mpeg", data: "UklGRg==" } },
      { inlineData: { mimeType: "application/pdf", data: "JVBERi0=" } },
    ],
  });
  assert.deepEqual(contents[1], {
    role: "model",
    parts: [{ functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: "skip_thought_signature_validator" }],
  });
  assert.deepEqual(contents[2], { role: "user", parts: [{ functionResponse: { name: "lookup", response: { result: "found" } } }] });
  assert.deepEqual(request.tools, [
    {
      functionDeclarations: [
        {
          name: "lookup",
          description: "Look up",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      ],
    },
  ]);
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: "ANY" } });
  assert.deepEqual(request.generationConfig, {
    temperature: 0.3,
    stopSequences: ["END"],
    maxOutputTokens: 900,
    topK: 20,
    seed: 7,
    presencePenalty: 0.1,
    frequencyPenalty: 0.2,
  });
});

test("remote media and unsupported parts are rejected instead of dropped", () => {
  const send = (part: JsonMap) => () => chatToGemini("vertex", { model: "gemini-2.5-pro", messages: [{ role: "user", content: [part] }] });
  const rejected = (err: unknown) => err instanceof GateError && err.status === 400 && err.code === "unsupported_parameter";
  assert.throws(send({ type: "image_url", image_url: { url: "https://example.com/cat.png" } }), rejected);
  assert.throws(send({ type: "input_audio", input_audio: { data: "x", format: "midi" } }), rejected);
  assert.throws(send({ type: "file", file: { file_id: "file-1" } }), rejected);
  assert.throws(send({ type: "video_url", video_url: "x" }), rejected);
});

test("conversation edges get the user turns Gemini expects", () => {
  const converted = chatToGemini("gemini", {
    model: "gemini-2.5-flash",
    messages: [{ role: "assistant", content: "Hello" }],
  });
  assert.deepEqual((converted.request as JsonMap).contents, [
    { role: "user", parts: [{ text: "" }] },
    { role: "model", parts: [{ text: "Hello" }] },
    { role: "user", parts: [{ text: "" }] },
  ]);
  const gemma = chatToGemini("gemini", {
    model: "gemma-3-27b-it",
    messages: [
      { role: "system", content: "Answer in German." },
      { role: "user", content: "Hi" },
    ],
  }).request as JsonMap;
  assert.equal(gemma.systemInstruction, undefined);
  assert.deepEqual(gemma.contents, [{ role: "user", parts: [{ text: "Answer in German." }, { text: "Hi" }] }]);
});

test("reasoning effort maps to thinking levels on Gemini 3 and budgets on Gemini 2.5", () => {
  assert.deepEqual(geminiThinking("gemini-3-flash-preview", "minimal", 0), { includeThoughts: true, thinkingLevel: "minimal" });
  assert.deepEqual(geminiThinking("gemini-3-flash-preview", "medium", 0), { includeThoughts: true, thinkingLevel: "medium" });
  assert.deepEqual(geminiThinking("gemini-3-pro-preview", "medium", 0), { includeThoughts: true, thinkingLevel: "high" });
  assert.deepEqual(geminiThinking("gemini-3-pro-preview", "minimal", 0), { includeThoughts: true, thinkingLevel: "low" });
  assert.deepEqual(geminiThinking("gemini-4-argon", "minimal", 0), { includeThoughts: true, thinkingLevel: "low" });
  assert.deepEqual(geminiThinking("gemini-3.1-pro", "xhigh", 0), { includeThoughts: true, thinkingLevel: "high" });
  assert.deepEqual(geminiThinking("gemini-3-pro-preview", "none", 0), { includeThoughts: false, thinkingLevel: "low" });
  assert.deepEqual(geminiThinking("gemini-2.5-pro", "medium", 0), { includeThoughts: true, thinkingBudget: 8192 });
  assert.deepEqual(geminiThinking("gemini-2.5-flash", "max", 0), { includeThoughts: true, thinkingBudget: 24576 });
  assert.deepEqual(geminiThinking("gemini-2.5-flash", "none", 0), { thinkingBudget: 0 });
  assert.equal(geminiThinking("gemini-2.5-pro", "none", 0), null);
  assert.equal(geminiThinking("gemini-2.5-pro", "high", 4000), null);
  assert.equal(geminiThinking("gemma-3-27b-it", "high", 0), null);
  assert.equal(geminiThinking("gemini-2.5-pro", "", 0), null);
  const request = chatToGemini("gemini", {
    model: "gemini-3-flash-preview",
    messages: [{ role: "user", content: "x" }],
    reasoning: { effort: "low" },
  }).request as JsonMap;
  assert.deepEqual(request.generationConfig, { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } });
});

test("Vertex Claude requests use the Anthropic body with the Vertex version and no model", () => {
  const payload = googlePayload("vertex", "/chat/completions", {
    model: "claude-sonnet-4-5@20250929",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ],
    max_tokens: 300,
  });
  assert.equal(payload.model, "claude-sonnet-4-5@20250929");
  const wire = googleWire("vertex", "/chat/completions", payload);
  assert.equal(wire.model, undefined);
  assert.equal(wire.anthropic_version, "vertex-2023-10-16");
  assert.equal(wire.stream, true);
  assert.equal(wire.system, "Be brief.");
  assert.equal(wire.max_tokens, 300);
  assert.deepEqual(wire.messages, [{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
  const partner = googlePayload("vertex", "/chat/completions", {
    model: "publishers/meta/models/llama-4-maverick-17b-128e-instruct-maas",
    messages: [{ role: "user", content: "Hi" }],
  });
  assert.equal(partner.model, "meta/llama-4-maverick-17b-128e-instruct-maas");
  assert.deepEqual(googleWire("vertex", "/chat/completions", partner), partner);
});

test("Vertex Claude keeps signed thinking blocks in the history", async () => {
  const { prepareBody } = await import("@/lib/gateway/dispatch/upstream");
  const thinking = [{ type: "thinking", thinking: "plan", signature: "sig" }];
  const messages = [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello", thinking_blocks: thinking },
    { role: "user", content: "Again" },
  ];
  const claude = prepareBody(deployment("vertex", "claude-sonnet-4-5", GLOBAL_BASE), "/chat/completions", { model: "x", messages });
  const assistant = (claude.messages as JsonMap[]).find((message) => message.role === "assistant")!;
  assert.deepEqual((assistant.content as JsonMap[])[0], { type: "thinking", thinking: "plan", signature: "sig" });
  const gemini = prepareBody(deployment("vertex", "gemini-2.5-pro", GLOBAL_BASE), "/chat/completions", { model: "x", messages });
  assert.equal(JSON.stringify(gemini).includes("sig"), false);
});

test("Imagen requests and predictions translate to the OpenAI images shape", () => {
  assert.deepEqual(imagenRequest({ prompt: "A red fox", n: 9, size: "1792x1024", output_format: "jpeg" }), {
    instances: [{ prompt: "A red fox" }],
    parameters: { sampleCount: 4, aspectRatio: "16:9", outputOptions: { mimeType: "image/jpeg" } },
  });
  assert.deepEqual(imagenRequest({ prompt: "A fox" }), { instances: [{ prompt: "A fox" }], parameters: { sampleCount: 1 } });
  assert.equal(vertexAspectRatio("1024x1792"), "9:16");
  assert.equal(vertexAspectRatio("1024x1024"), "1:1");
  assert.equal(vertexAspectRatio("auto"), "");
  assert.throws(() => imagenRequest({ prompt: " " }), (err: unknown) => err instanceof GateError && err.status === 400);
  assert.throws(() => imagenRequest({ prompt: "x", stream: true }), (err: unknown) => err instanceof GateError && err.status === 400);
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.deepEqual(
    imagenImages({ predictions: [{ bytesBase64Encoded: "aW1n", mimeType: "image/png", prompt: "A fox, detailed" }, { raiFilteredReason: "x" }] }, now),
    { created: now / 1000, data: [{ b64_json: "aW1n", revised_prompt: "A fox, detailed" }] },
  );
  assert.throws(() => imagenImages({ predictions: [] }), (err: unknown) => err instanceof GateError && err.status === 502);
});

test("a Gemini chat goes out as streamGenerateContent and returns one completion with tools, thoughts, and usage", async () => {
  const { proxyJson } = await import("@/lib/gateway/dispatch/upstream");
  respondWith(
    () =>
      new Response(
        sse(
          { candidates: [{ content: { role: "model", parts: [{ text: "Considering", thought: true }] } }] },
          { candidates: [{ content: { role: "model", parts: [{ text: "Let me check." }] } }] },
          {
            candidates: [
              {
                content: { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "berlin" } } }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, thoughtsTokenCount: 5, totalTokenCount: 25 },
          },
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  const result = await proxyJson({
    dep: deployment("gemini", "gemini-2.5-flash", GEMINI_BASE),
    auth: { key: "AIzaTest", headers: {}, keyHeader: "x-goog-api-key" },
    path: "/chat/completions",
    body: { model: "alias", messages: [{ role: "user", content: "Weather?" }], stream: false, reasoning_effort: "low" },
  });
  assert.equal(result.status, 200);
  assert.equal(calls[0]!.url, `${GEMINI_BASE}/models/gemini-2.5-flash:streamGenerateContent?alt=sse`);
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers["x-goog-api-key"], "AIzaTest");
  const sent = JSON.parse(String(calls[0]!.init?.body)) as JsonMap;
  assert.deepEqual(sent.contents, [{ role: "user", parts: [{ text: "Weather?" }] }]);
  assert.deepEqual((sent.generationConfig as JsonMap).thinkingConfig, { includeThoughts: true, thinkingBudget: 1024 });
  assert.equal(sent.model, undefined);
  const json = result.json as JsonMap;
  const choice = (json.choices as JsonMap[])[0]!;
  const message = choice.message as JsonMap;
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(message.content, "Let me check.");
  assert.equal(message.reasoning_content, "Considering");
  const calls0 = message.tool_calls as JsonMap[];
  assert.equal((calls0[0]!.function as JsonMap).name, "lookup");
  assert.equal((calls0[0]!.function as JsonMap).arguments, '{"q":"berlin"}');
  assert.deepEqual(json.usage, {
    prompt_tokens: 12,
    completion_tokens: 13,
    total_tokens: 25,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 5 },
  });
});

test("Vertex Claude replies stream through streamRawPredict and aggregate into a completion", async () => {
  const { proxyJson } = await import("@/lib/gateway/dispatch/upstream");
  respondWith(
    () =>
      new Response(
        anthropicSse(
          ["message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 9, output_tokens: 1 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi there" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }],
          ["message_stop", { type: "message_stop" }],
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  const result = await proxyJson({
    dep: deployment("vertex", "claude-sonnet-4-5@20250929", GLOBAL_BASE),
    auth: { key: "ya29.token", headers: {} },
    path: "/chat/completions",
    body: { model: "alias", messages: [{ role: "user", content: "Hi" }], stream: false },
  });
  assert.equal(calls[0]!.url, `${GLOBAL_BASE}/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict`);
  const sent = JSON.parse(String(calls[0]!.init?.body)) as JsonMap;
  assert.equal(sent.anthropic_version, "vertex-2023-10-16");
  assert.equal(sent.model, undefined);
  const choice = ((result.json as JsonMap).choices as JsonMap[])[0]!;
  assert.equal((choice.message as JsonMap).content, "Hi there");
  assert.equal(choice.finish_reason, "stop");
  assert.equal(((result.json as JsonMap).usage as JsonMap).completion_tokens, 4);
});

test("Vertex partner models pass OpenAI chat through and Imagen returns base64 images", async () => {
  const { proxyJson } = await import("@/lib/gateway/dispatch/upstream");
  respondWith((url) =>
    url.endsWith(":predict")
      ? Response.json({ predictions: [{ bytesBase64Encoded: "aW1n", mimeType: "image/png" }] })
      : Response.json({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
  );
  const chat = await proxyJson({
    dep: deployment("vertex", "meta/llama-4-maverick-17b-128e-instruct-maas", SA_BASE),
    auth: { key: "ya29.token", headers: {} },
    path: "/chat/completions",
    body: { model: "alias", messages: [{ role: "user", content: "Hi" }], stream: false },
  });
  assert.equal(calls[0]!.url, `${SA_BASE}/endpoints/openapi/chat/completions`);
  assert.equal((JSON.parse(String(calls[0]!.init?.body)) as JsonMap).model, "meta/llama-4-maverick-17b-128e-instruct-maas");
  assert.equal((((chat.json as JsonMap).choices as JsonMap[])[0]!.message as JsonMap).content, "ok");
  const images = await proxyJson({
    dep: deployment("vertex", "imagen-4.0-generate-001", SA_BASE),
    auth: { key: "ya29.token", headers: {} },
    path: "/images/generations",
    body: { model: "alias", prompt: "A fox", size: "1024x1024" },
  });
  assert.equal(calls[1]!.url, `${SA_BASE}/publishers/google/models/imagen-4.0-generate-001:predict`);
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), {
    instances: [{ prompt: "A fox" }],
    parameters: { sampleCount: 1, aspectRatio: "1:1" },
  });
  assert.deepEqual(((images.json as JsonMap).data as JsonMap[])[0], { b64_json: "aW1n" });
});

test("Google stream chunks translate to OpenAI chunks, and partner streams pass through", () => {
  const translator = googleStreamTranslator("vertex", "gemini-2.5-pro", "alias")!;
  const out = sse(
    { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] },
    {
      candidates: [{ content: { role: "model", parts: [{ text: "lo" }, { functionCall: { name: "f", args: {} } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    },
  )
    .split("\n")
    .flatMap((line) => translator.pushLine(line))
    .map((payload) => JSON.parse(payload) as JsonMap);
  const deltas = out.map((chunk) => ((chunk.choices as JsonMap[])[0]!.delta as JsonMap));
  assert.equal(deltas[0]!.content, "Hel");
  assert.equal(deltas[1]!.content, "lo");
  assert.equal(((deltas[2]!.tool_calls as JsonMap[])[0]!.function as JsonMap).name, "f");
  assert.equal(((out.at(-1)!.choices as JsonMap[])[0]!).finish_reason, "tool_calls");
  assert.equal((out.at(-1)!.usage as JsonMap).total_tokens, 5);
  assert.equal(out.every((chunk) => chunk.model === "alias"), true);
  assert.ok(googleStreamTranslator("vertex", "claude-sonnet-4-5", "alias"));
  assert.equal(googleStreamTranslator("vertex", "meta/llama-4-maverick-17b-128e-instruct-maas", "alias"), null);
  const failing = googleStreamTranslator("gemini", "gemini-2.5-flash", "alias")!;
  assert.throws(
    () => failing.pushLine(`data: ${JSON.stringify({ error: { code: 429, message: "quota", details: [{ retryDelay: "7s" }] } })}`),
    (err: unknown) => err instanceof GateError && err.status === 429 && err.retryAt !== null,
  );
});

test("a blocked prompt finishes as content_filter instead of a cut stream", () => {
  const completion = googleResponse(
    "gemini",
    "/chat/completions",
    "gemini-2.5-flash",
    sse({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 4, totalTokenCount: 4 } }),
    {},
  ) as JsonMap;
  const choice = (completion.choices as JsonMap[])[0]!;
  assert.equal(choice.finish_reason, "content_filter");
  assert.equal((completion.usage as JsonMap).prompt_tokens, 4);
});

test("non-chat Google responses pass through unchanged", () => {
  const json = { data: [{ embedding: [0.1] }] };
  assert.equal(googleResponse("gemini", "/embeddings", "gemini-embedding-001", "", json), json);
});

test("a Google rate limit names its retry time so the deployment cools down until then", async () => {
  const { upstreamError } = await import("@/lib/gateway/dispatch/upstream");
  const now = Date.now();
  const error = upstreamError(429, {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "Quota exceeded",
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }],
    },
  });
  assert.equal(error.status, 429);
  assert.equal(error.message, "Quota exceeded");
  assert.ok(error.retryAt !== null && error.retryAt >= now + 29_000);
});

test("service account keys are validated and normalized to PKCS#8", async () => {
  const { normalizePrivateKey, parseVertexCredential } = await import("@/lib/gateway/upstreams/vertex-credentials");
  const parsed = parseVertexCredential(serviceAccountJson());
  assert.equal(parsed.type, "service_account");
  if (parsed.type !== "service_account") return;
  assert.equal(parsed.account.client_email, "hub@hub-test-project.iam.gserviceaccount.com");
  assert.equal(parsed.account.project_id, "hub-test-project");
  assert.match(parsed.account.private_key, /^-----BEGIN PRIVATE KEY-----\n/);
  assert.match(normalizePrivateKey(pkcs1), /^-----BEGIN PRIVATE KEY-----\n/);
  const escaped = privateKey.replace(/\n/g, "\\n");
  assert.match(normalizePrivateKey(escaped), /^-----BEGIN PRIVATE KEY-----\n/);
  const flattened = privateKey.replace(/\n(?!-----END)/g, " ");
  assert.match(normalizePrivateKey(flattened), /^-----BEGIN PRIVATE KEY-----\n/);
  assert.deepEqual(parseVertexCredential("  AIzaSyExampleExpressModeKey_123  "), { type: "api_key", key: "AIzaSyExampleExpressModeKey_123" });
  const invalid = (raw: string) => () => parseVertexCredential(raw);
  const rejected = (err: unknown) => err instanceof Error && err.message === "VERTEX_SERVICE_ACCOUNT_INVALID";
  assert.throws(invalid("{not json"), rejected);
  assert.throws(invalid(serviceAccountJson({ type: "authorized_user" })), rejected);
  assert.throws(invalid(serviceAccountJson({ client_email: "" })), rejected);
  assert.throws(invalid(serviceAccountJson({ private_key: ecKey })), rejected);
  assert.throws(invalid(serviceAccountJson({ private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" })), rejected);
  assert.throws(invalid("short key"), rejected);
  assert.throws(invalid(""), rejected);
});

test("the browser can check a pasted key without the server", () => {
  assert.deepEqual(serviceAccountSummary(serviceAccountJson()), {
    project: "hub-test-project",
    email: "hub@hub-test-project.iam.gserviceaccount.com",
  });
  assert.equal(serviceAccountSummary(serviceAccountJson({ private_key: "" })), null);
  assert.equal(serviceAccountSummary("[]"), null);
  assert.equal(vertexCredentialKind(" {"), "service_account");
  assert.equal(vertexCredentialKind("AIza"), "api_key");
  assert.equal(vertexCredentialKind("  "), null);
});

test("connection input decides the sealed credential and the Vertex base URL", async () => {
  const { open } = await import("@/lib/crypto");
  const { vertexConnection } = await import("@/lib/gateway/upstreams/vertex-credentials");
  const created = vertexConnection({ credential: serviceAccountJson() });
  assert.equal(created.baseUrl, GLOBAL_BASE);
  assert.notEqual(created.apiKey, serviceAccountJson());
  const stored = JSON.parse(open(created.apiKey)) as JsonMap;
  assert.equal(stored.client_email, "hub@hub-test-project.iam.gserviceaccount.com");
  assert.equal("token_uri" in stored, false);
  assert.equal(
    vertexConnection({ credential: serviceAccountJson(), target: { project: "other-project-9", location: "europe-west4" } }).baseUrl,
    "https://europe-west4-aiplatform.googleapis.com/v1/projects/other-project-9/locations/europe-west4",
  );
  const express = vertexConnection({ credential: "AIzaSyExampleExpressModeKey_123" });
  assert.equal(express.baseUrl, EXPRESS_BASE);
  assert.equal(open(express.apiKey), "AIzaSyExampleExpressModeKey_123");
  assert.deepEqual(vertexConnection({ credential: "", target: { location: "us-central1" }, currentBaseUrl: GLOBAL_BASE }), {
    apiKey: "",
    baseUrl: SA_BASE,
  });
  assert.deepEqual(vertexConnection({ credential: "", currentBaseUrl: EXPRESS_BASE }), { apiKey: "", baseUrl: EXPRESS_BASE });
  const code = (expected: string) => (err: unknown) => err instanceof Error && err.message === expected;
  assert.throws(() => vertexConnection({ credential: "" }), code("VERTEX_CREDENTIAL_REQUIRED"));
  assert.throws(
    () => vertexConnection({ credential: serviceAccountJson(), target: { location: "moon-base" } }),
    code("VERTEX_LOCATION_INVALID"),
  );
  assert.throws(
    () => vertexConnection({ credential: serviceAccountJson({ project_id: "" }) }),
    code("VERTEX_PROJECT_INVALID"),
  );
  assert.throws(
    () => vertexConnection({ credential: serviceAccountJson(), target: { project: "Bad/Project" } }),
    code("VERTEX_PROJECT_INVALID"),
  );
});

test("the service account signs an RS256 assertion for the cloud-platform scope", async () => {
  const { parseVertexCredential, serviceAccountAssertion } = await import("@/lib/gateway/upstreams/vertex-credentials");
  const parsed = parseVertexCredential(serviceAccountJson());
  if (parsed.type !== "service_account") throw new Error("expected a service account");
  const now = Date.parse("2026-10-20T12:00:00Z");
  const jwt = serviceAccountAssertion(parsed.account, now);
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT", kid: "key-1" });
  assert.deepEqual(JSON.parse(Buffer.from(claims!, "base64url").toString()), {
    iss: "hub@hub-test-project.iam.gserviceaccount.com",
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now / 1000,
    exp: now / 1000 + 3600,
  });
  const verified = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, "base64url"));
  assert.equal(verified, true);
});

test("access tokens are exchanged once, shared by concurrent calls, and renewed shortly before expiry", async () => {
  const { forgetVertexToken, parseVertexCredential, vertexAccessToken } = await import("@/lib/gateway/upstreams/vertex-credentials");
  const parsed = parseVertexCredential(serviceAccountJson());
  if (parsed.type !== "service_account") throw new Error("expected a service account");
  let minted = 0;
  respondWith(async () => {
    minted += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ access_token: `ya29.token-${minted}`, expires_in: 3600, token_type: "Bearer" });
  });
  const now = Date.parse("2026-10-20T12:00:00Z");
  const [first, second] = await Promise.all([
    vertexAccessToken("vertex-cache-1", "sealed-a", parsed.account, now),
    vertexAccessToken("vertex-cache-1", "sealed-a", parsed.account, now),
  ]);
  assert.equal(first, "ya29.token-1");
  assert.equal(second, "ya29.token-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://oauth2.googleapis.com/token");
  const form = new URLSearchParams(String(calls[0]!.init?.body));
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(form.get("assertion")?.split(".").length, 3);
  assert.equal(await vertexAccessToken("vertex-cache-1", "sealed-a", parsed.account, now + 50 * 60_000), "ya29.token-1");
  assert.equal(await vertexAccessToken("vertex-cache-1", "sealed-a", parsed.account, now + 56 * 60_000), "ya29.token-2");
  assert.equal(await vertexAccessToken("vertex-cache-1", "sealed-b", parsed.account, now + 56 * 60_000), "ya29.token-3");
  forgetVertexToken("vertex-cache-1");
  assert.equal(await vertexAccessToken("vertex-cache-1", "sealed-b", parsed.account, now + 56 * 60_000), "ya29.token-4");
  assert.equal(calls.length, 4);
});

test("a rejected service account answers no_provider_key and a token endpoint outage is a 502", async () => {
  const { parseVertexCredential, vertexAccessToken } = await import("@/lib/gateway/upstreams/vertex-credentials");
  const parsed = parseVertexCredential(serviceAccountJson());
  if (parsed.type !== "service_account") throw new Error("expected a service account");
  respondWith(() => Response.json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: 400 }));
  await assert.rejects(
    vertexAccessToken("vertex-rejected-1", "sealed", parsed.account),
    (err: unknown) => err instanceof GateError && err.status === 503 && err.code === "no_provider_key" && /invalid_grant/.test(err.message),
  );
  respondWith(() => new Response("unavailable", { status: 503 }));
  await assert.rejects(
    vertexAccessToken("vertex-outage-1", "sealed", parsed.account),
    (err: unknown) => err instanceof GateError && err.status === 502,
  );
});

test("provider auth for Vertex mints a token from the sealed service account or sends the express key", async () => {
  const { seal } = await import("@/lib/crypto");
  const { providerAuth } = await import("@/lib/gateway/upstreams/credentials");
  respondWith(() => Response.json({ access_token: "ya29.provider", expires_in: 3600 }));
  const auth = await providerAuth({ id: "vertex-auth-1", kind: "vertex", apiKey: seal(serviceAccountJson()) });
  assert.deepEqual(auth, { key: "ya29.provider", headers: {} });
  const express = await providerAuth({ id: "vertex-auth-2", kind: "vertex", apiKey: seal("AIzaSyExampleExpressModeKey_123") });
  assert.deepEqual(express, { key: "AIzaSyExampleExpressModeKey_123", headers: {}, keyHeader: "x-goog-api-key" });
  const gemini = await providerAuth({ id: "gemini-auth-1", kind: "gemini", apiKey: seal("AIzaGemini") });
  assert.deepEqual(gemini, { key: "AIzaGemini", headers: {}, keyHeader: "x-goog-api-key" });
  await assert.rejects(
    providerAuth({ id: "vertex-auth-3", kind: "vertex", apiKey: seal("{broken") }),
    (err: unknown) => err instanceof GateError && err.code === "no_provider_key",
  );
  assert.equal(calls.length, 1);
});

test("a 401 from Vertex drops the cached token so the next call mints a new one", async () => {
  const { parseVertexCredential, vertexAccessToken } = await import("@/lib/gateway/upstreams/vertex-credentials");
  const { proxyJson } = await import("@/lib/gateway/dispatch/upstream");
  const parsed = parseVertexCredential(serviceAccountJson());
  if (parsed.type !== "service_account") throw new Error("expected a service account");
  let minted = 0;
  respondWith((url) => {
    if (url === "https://oauth2.googleapis.com/token") {
      minted += 1;
      return Response.json({ access_token: `ya29.retry-${minted}`, expires_in: 3600 });
    }
    return Response.json({ error: { code: 401, message: "Request had invalid authentication credentials." } }, { status: 401 });
  });
  const dep = deployment("vertex", "gemini-2.5-pro", SA_BASE);
  assert.equal(await vertexAccessToken(dep.provider!.id, "sealed", parsed.account), "ya29.retry-1");
  const result = await proxyJson({
    dep,
    auth: { key: "ya29.retry-1", headers: {} },
    path: "/chat/completions",
    body: { model: "alias", messages: [{ role: "user", content: "Hi" }] },
  });
  assert.equal(result.status, 401);
  assert.equal(await vertexAccessToken(dep.provider!.id, "sealed", parsed.account), "ya29.retry-2");
});

test("the provider view names the service account but never carries the private key", async () => {
  const { vertexConnection, vertexView } = await import("@/lib/gateway/upstreams/vertex-credentials");
  const sa = vertexConnection({ credential: serviceAccountJson(), target: { location: "us-central1" } });
  const view = vertexView({ id: "vertex-view-1", ...sa });
  assert.deepEqual(view, {
    credential: "service_account",
    account: "hub@hub-test-project.iam.gserviceaccount.com",
    project: "hub-test-project",
    location: "us-central1",
  });
  assert.equal(JSON.stringify(view).includes("PRIVATE KEY"), false);
  const express = vertexConnection({ credential: "AIzaSyExampleExpressModeKey_123" });
  assert.deepEqual(vertexView({ id: "vertex-view-2", ...express }), { credential: "api_key", account: "", project: "", location: "" });
});

test("Gemini model lists keep generation, embedding, and image models across pages", async () => {
  const { fetchGeminiModels, geminiModels } = await import("@/lib/gateway/upstreams/google-models");
  assert.deepEqual(geminiModels({ models: [{ name: "models/aqa", supportedGenerationMethods: ["generateAnswer"] }] }).models, []);
  respondWith((url) =>
    url.includes("pageToken=p2")
      ? Response.json({
          models: [{ name: "models/gemini-embedding-001", displayName: "Gemini Embedding", supportedGenerationMethods: ["embedContent"] }],
        })
      : Response.json({
          models: [
            { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent", "countTokens"] },
            { name: "models/imagen-4.0-generate-001", displayName: "Imagen 4", supportedGenerationMethods: ["predict"] },
            { name: "models/aqa", supportedGenerationMethods: ["generateAnswer"] },
          ],
          nextPageToken: "p2",
        }),
  );
  const models = await fetchGeminiModels(GEMINI_BASE, { key: "AIzaTest", headers: {}, keyHeader: "x-goog-api-key" });
  assert.deepEqual(models.map((model) => model.id), ["gemini-2.5-flash", "gemini-embedding-001", "imagen-4.0-generate-001"]);
  assert.equal(models[0]!.contextLength, 1048576);
  assert.equal(models[0]!.ownedBy, "google");
  assert.equal(calls[0]!.url, `${GEMINI_BASE}/models?pageSize=1000`);
  assert.equal(calls[1]!.url, `${GEMINI_BASE}/models?pageSize=1000&pageToken=p2`);
  assert.equal((calls[0]!.init?.headers as Record<string, string>)["x-goog-api-key"], "AIzaTest");
  respondWith(() => Response.json({ error: { code: 400, message: "API key not valid" } }, { status: 403 }));
  await assert.rejects(fetchGeminiModels(GEMINI_BASE, { key: "bad", headers: {}, keyHeader: "x-goog-api-key" }), /UPSTREAM_AUTH/);
});

test("Vertex discovery lists Gemini, Imagen, and versioned Claude models with the service account token", async () => {
  const { fetchVertexModels } = await import("@/lib/gateway/upstreams/google-models");
  respondWith((url) => {
    if (url.includes("/publishers/anthropic/")) {
      return Response.json({
        publisherModels: [
          { name: "publishers/anthropic/models/claude-sonnet-4-5", versionId: "20250929" },
          { name: "publishers/anthropic/models/claude-3-haiku", versionId: "001" },
          { name: "publishers/anthropic/models/other-model" },
        ],
      });
    }
    return Response.json({
      publisherModels: [
        { name: "publishers/google/models/gemini-2.5-pro", versionId: "001" },
        { name: "publishers/google/models/gemini-live-2.5-flash" },
        { name: "publishers/google/models/gemini-embedding-001" },
        { name: "publishers/google/models/imagen-4.0-generate-001" },
        { name: "publishers/google/models/veo-3.0-generate-001" },
      ],
    });
  });
  const models = await fetchVertexModels(SA_BASE, { key: "ya29.token", headers: {} });
  assert.deepEqual(models.map((model) => [model.id, model.ownedBy]), [
    ["gemini-2.5-pro", "google"],
    ["imagen-4.0-generate-001", "google"],
    ["claude-3-haiku", "anthropic"],
    ["claude-sonnet-4-5@20250929", "anthropic"],
  ]);
  assert.equal(calls[0]!.url, "https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100");
  assert.equal(calls[1]!.url, "https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/anthropic/models?pageSize=100");
  assert.equal((calls[0]!.init?.headers as Record<string, string>).Authorization, "Bearer ya29.token");
});

test("express mode falls back to the known Gemini models after a key check", async () => {
  const { fetchVertexModels, VERTEX_EXPRESS_MODELS } = await import("@/lib/gateway/upstreams/google-models");
  const auth = { key: "AIzaExpress", headers: {}, keyHeader: "x-goog-api-key" };
  respondWith((url) =>
    url.endsWith(":countTokens") ? Response.json({ totalTokens: 1 }) : Response.json({ error: { code: 403 } }, { status: 403 }),
  );
  const models = await fetchVertexModels(EXPRESS_BASE, auth);
  assert.deepEqual(models.map((model) => model.id), VERTEX_EXPRESS_MODELS.map((model) => model.id));
  assert.equal(calls[1]!.url, "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:countTokens");
  assert.equal((calls[1]!.init?.headers as Record<string, string>)["x-goog-api-key"], "AIzaExpress");
  respondWith(() => Response.json({ error: { code: 400, message: "API key not valid" } }, { status: 400 }));
  await assert.rejects(fetchVertexModels(EXPRESS_BASE, auth), /UPSTREAM_AUTH/);
});

test("the catalog files Google models under their vendors and folds Vertex Claude versions", () => {
  assert.equal(vendorOf("gemini", "gemini-2.5-pro"), "google");
  assert.equal(vendorOf("vertex", "gemini-2.5-pro"), "google");
  assert.equal(vendorOf("vertex", "claude-sonnet-4-5@20250929"), "anthropic");
  assert.equal(vendorOf("vertex", "meta/llama-4-maverick-17b-128e-instruct-maas"), "meta");
  assert.equal(trustedKind("gemini"), true);
  assert.equal(trustedKind("vertex"), true);
  assert.equal(snapshotNames(["claude-sonnet-4-5@20250929"]).get("claude-sonnet-4-5@20250929"), "claude-sonnet-4-5");
});

test("Gemini and Vertex drop OpenAI service tiers they do not define", async () => {
  const { applyProviderServiceMode } = await import("@/lib/gateway/dispatch/service-mode");
  for (const kind of ["gemini", "vertex"]) {
    const mapped = applyProviderServiceMode(kind, { service_tier: "priority", speed: "fast" }, "fast");
    assert.equal(mapped.body.service_tier, undefined);
    assert.equal(mapped.body.speed, undefined);
  }
});
