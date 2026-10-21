import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { AnthropicSseTranslator, chatToAnthropic } from "@/lib/gateway/protocols/anthropic";
import { completionFromSse } from "@/lib/gateway/protocols/sse-completion";
import { AntigravitySseTranslator, chatToAntigravity } from "@/lib/gateway/upstreams/antigravity";
import {
  VERTEX_ANTHROPIC_VERSION,
  vertexAspectRatio,
  vertexModelRoute,
  vertexTarget,
} from "@/lib/gateway/upstreams/vertex-target";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { ChatSseTranslator, JsonMap } from "@/types/gateway";
import type { ThinkingLevel, VertexModelRoute } from "@/types/providers";

export const GEMINI_API_VERSION = "v1beta";
export const GEMINI_STREAM_ACTION = "streamGenerateContent?alt=sse";
export const GOOGLE_KEY_HEADER = "x-goog-api-key";

const GEMINI_OPENAI_PATHS = ["/embeddings", "/images/generations", "/videos", "/models"];
const PROVIDER_LABELS: Record<string, string> = { gemini: "the Gemini API", vertex: "Vertex AI" };
const VERSION_SEGMENT = /\/v[0-9]+(?:alpha|beta)?[0-9]*$/;
const SAFE_MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const OPTIONAL_THINKING = /^gemini-2\.5-flash/i;
const FLASH_MODEL = /flash/i;
const FLASH_THINKING_LIMIT = 24576;
const AUDIO_MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  aiff: "audio/aiff",
};
const EMPTY_USER_TURN: JsonMap = { role: "user", parts: [{ text: "" }] };
const IMAGEN_MODEL = /^imagen-/i;
const GEMMA_MODEL = /^gemma-/i;
const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high"];
const EFFORT_LEVELS: Record<string, ThinkingLevel> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};
const THINKING_BUDGETS: Record<string, number> = { minimal: 1024, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 32768 };
const THINKING_LEVEL_TABLE: { match: RegExp; levels: readonly ThinkingLevel[] }[] = [
  { match: /^gemini-3-pro/i, levels: ["low", "high"] },
  { match: /^gemini-3\.1-pro/i, levels: ["low", "medium", "high"] },
  { match: /^gemini-3\.1-flash-image/i, levels: ["minimal", "high"] },
  { match: /^gemini-3\.8-flash|^gemini-4-/i, levels: ["low", "medium", "high"] },
];
const IMAGEN_MAX_IMAGES = 4;

function labelOf(kind: string): string {
  return PROVIDER_LABELS[kind] ?? "this provider";
}

function chatPath(path: string): boolean {
  return path.includes("chat/completions");
}

function unsupportedPart(message: string): GateError {
  return new GateError(400, "unsupported_parameter", message, { param: "messages" });
}

function unsupportedEndpoint(kind: string): GateError {
  return new GateError(400, "unsupported_endpoint", `this endpoint is not available on ${labelOf(kind)}`);
}

export function geminiRoot(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "").replace(/\/openai$/, "");
  return VERSION_SEGMENT.test(trimmed) ? trimmed : `${trimmed}/${GEMINI_API_VERSION}`;
}

export function googleModelRoute(kind: string, model: string): VertexModelRoute {
  if (kind === "vertex") return vertexModelRoute(model);
  return { route: "google", model: model.trim().replace(/^models\//, "") };
}

function modelSegment(model: string): string {
  if (!SAFE_MODEL_SEGMENT.test(model)) {
    throw new GateError(400, "invalid_request", "the model name contains characters Google does not accept", { param: "model" });
  }
  return model;
}

export function googlePath(kind: string, base: string, model: string, path: string): string {
  const root = base.replace(/\/+$/, "");
  if (kind === "gemini") {
    const gemini = geminiRoot(root);
    if (chatPath(path)) return `${gemini}/models/${modelSegment(googleModelRoute(kind, model).model)}:${GEMINI_STREAM_ACTION}`;
    const rel = (path.startsWith("/") ? path : `/${path}`).replace(/^\/v1(?=\/)/, "");
    if (!GEMINI_OPENAI_PATHS.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) throw unsupportedEndpoint(kind);
    return `${gemini}/openai${rel}`;
  }
  const route = vertexModelRoute(model);
  if (imagePath(path)) {
    if (route.route !== "google" || !IMAGEN_MODEL.test(route.model)) {
      throw new GateError(400, "unsupported_parameter", "image generation on Vertex AI needs an Imagen model", { param: "model" });
    }
    requireProject(root, "Imagen models");
    return `${root}/publishers/google/models/${modelSegment(route.model)}:predict`;
  }
  if (!chatPath(path)) throw unsupportedEndpoint(kind);
  if (route.route === "google") return `${root}/publishers/google/models/${modelSegment(route.model)}:${GEMINI_STREAM_ACTION}`;
  requireProject(root, "partner models");
  if (route.route === "anthropic") return `${root}/publishers/anthropic/models/${modelSegment(route.model)}:streamRawPredict`;
  return `${root}/endpoints/openapi/chat/completions`;
}

function requireProject(root: string, what: string): void {
  if (vertexTarget(root)) return;
  throw new GateError(400, "unsupported_parameter", `${what} on Vertex AI need a service account with a project`, {
    param: "model",
  });
}

function imagePath(path: string): boolean {
  return /(?:^|\/)images\/generations$/.test(path);
}

export function imagenRequest(body: JsonMap): JsonMap {
  const prompt = asString(body.prompt).trim();
  if (!prompt) throw new GateError(400, "missing_required_parameter", "prompt is required", { param: "prompt" });
  if (body.stream === true) {
    throw new GateError(400, "unsupported_parameter", "Imagen on Vertex AI does not stream images", { param: "stream" });
  }
  const parameters: JsonMap = { sampleCount: Math.min(IMAGEN_MAX_IMAGES, Math.max(1, asNumber(body.n, 1))) };
  const ratio = vertexAspectRatio(asString(body.size));
  if (ratio) parameters.aspectRatio = ratio;
  const format = asString(body.output_format);
  if (format === "jpeg" || format === "png") parameters.outputOptions = { mimeType: `image/${format}` };
  return { instances: [{ prompt }], parameters };
}

export function imagenImages(json: unknown, now = Date.now()): JsonMap {
  const predictions = asRecord(json)?.predictions;
  const data = (Array.isArray(predictions) ? predictions : []).flatMap((raw) => {
    const prediction = asRecord(raw);
    const image = asString(prediction?.bytesBase64Encoded);
    if (!image) return [];
    const revised = asString(prediction?.prompt);
    return [{ b64_json: image, ...(revised ? { revised_prompt: revised } : {}) }];
  });
  if (!data.length) throw new GateError(502, "upstream_error", "Vertex AI returned no images; the prompt may have been filtered");
  return { created: Math.floor(now / 1000), data };
}

function dataUrlPart(url: string): JsonMap {
  return { type: "image_url", image_url: { url } };
}

function inlinePart(kind: string, part: JsonMap): JsonMap {
  const type = asString(part.type);
  if (type === "text" || type === "input_text") return part;
  if (type === "image_url") {
    const url = typeof part.image_url === "string" ? part.image_url : asString(asRecord(part.image_url)?.url);
    if (!url.startsWith("data:")) throw unsupportedPart(`${labelOf(kind)} accepts images only as base64 data URLs`);
    return dataUrlPart(url);
  }
  if (type === "input_audio") {
    const audio = asRecord(part.input_audio);
    const mime = AUDIO_MIME[asString(audio?.format, "wav").toLowerCase()];
    const data = asString(audio?.data);
    if (!mime || !data) throw unsupportedPart(`${labelOf(kind)} accepts audio as base64 wav, mp3, aac, flac, ogg, or aiff`);
    return dataUrlPart(`data:${mime};base64,${data}`);
  }
  if (type === "file") {
    const data = asString(asRecord(part.file)?.file_data);
    if (!data.startsWith("data:")) throw unsupportedPart(`${labelOf(kind)} accepts files only as base64 data URLs`);
    return dataUrlPart(data);
  }
  throw unsupportedPart(`${labelOf(kind)} does not support ${type || "this"} content parts`);
}

function withInlineParts(kind: string, body: JsonMap): JsonMap {
  if (!Array.isArray(body.messages)) return body;
  const messages = body.messages.map((raw) => {
    const message = asRecord(raw);
    if (!message || !Array.isArray(message.content) || message.role === "tool") return raw;
    if (message.role === "system" || message.role === "developer") return raw;
    const content = message.content.map((part) => {
      const rec = asRecord(part);
      return rec ? inlinePart(kind, rec) : part;
    });
    return { ...message, content };
  });
  return { ...body, messages };
}

function withoutCallIds(contents: JsonMap[]): JsonMap[] {
  return contents.map((content) => {
    if (!Array.isArray(content.parts)) return content;
    const parts = content.parts.map((raw) => {
      const part = asRecord(raw);
      if (!part) return raw;
      for (const key of ["functionCall", "functionResponse"] as const) {
        const call = asRecord(part[key]);
        if (call && "id" in call) {
          const copy = { ...call };
          delete copy.id;
          return { ...part, [key]: copy };
        }
      }
      return part;
    });
    return { ...content, parts };
  });
}

function withTurnBoundaries(contents: JsonMap[]): JsonMap[] {
  const out = [...contents];
  if (out[0]?.role === "model") out.unshift(EMPTY_USER_TURN);
  if (out.length > 1 && out[out.length - 1]?.role === "model") out.push(EMPTY_USER_TURN);
  return out;
}

function geminiMajor(model: string): number {
  const match = /^gemini-(\d+)/i.exec(model);
  return match ? Number(match[1]) : 0;
}

export function thinkingLevels(model: string): readonly ThinkingLevel[] {
  return THINKING_LEVEL_TABLE.find((row) => row.match.test(model))?.levels ?? ALL_THINKING_LEVELS;
}

function supportedLevel(model: string, wanted: ThinkingLevel): ThinkingLevel {
  const levels = thinkingLevels(model);
  const rank = ALL_THINKING_LEVELS.indexOf(wanted);
  return levels.find((level) => ALL_THINKING_LEVELS.indexOf(level) >= rank) ?? levels[levels.length - 1]!;
}

export function geminiThinking(model: string, effort: string, maxOutput: number): JsonMap | null {
  if (!effort) return null;
  if (geminiMajor(model) >= 3) {
    if (effort === "none") return { includeThoughts: false, thinkingLevel: thinkingLevels(model)[0] };
    return { includeThoughts: true, thinkingLevel: supportedLevel(model, EFFORT_LEVELS[effort] ?? "high") };
  }
  if (effort === "none") return OPTIONAL_THINKING.test(model) ? { thinkingBudget: 0 } : null;
  const wanted = THINKING_BUDGETS[effort];
  if (!wanted || !/^gemini-/i.test(model)) return null;
  const budget = FLASH_MODEL.test(model) ? Math.min(wanted, FLASH_THINKING_LIMIT) : wanted;
  if (maxOutput > 0 && maxOutput <= budget) return null;
  return { includeThoughts: true, thinkingBudget: budget };
}

function geminiGeneration(body: JsonMap, model: string, base: JsonMap): JsonMap {
  const config: JsonMap = { ...base };
  delete config.thinkingConfig;
  const maxOutput = asNumber(body.max_completion_tokens, asNumber(body.max_tokens, 0));
  if (maxOutput > 0) config.maxOutputTokens = maxOutput;
  if (typeof body.top_k === "number") config.topK = body.top_k;
  if (typeof body.seed === "number" && Number.isInteger(body.seed)) config.seed = body.seed;
  if (typeof body.presence_penalty === "number") config.presencePenalty = body.presence_penalty;
  if (typeof body.frequency_penalty === "number") config.frequencyPenalty = body.frequency_penalty;
  const effort = asString(body.reasoning_effort) || asString(asRecord(body.reasoning)?.effort);
  const thinking = geminiThinking(model, effort, maxOutput);
  if (thinking) config.thinkingConfig = thinking;
  return config;
}

function withoutSystemInstruction(request: JsonMap): JsonMap {
  const system = asRecord(request.systemInstruction);
  if (!system) return request;
  const copy = { ...request };
  delete copy.systemInstruction;
  const parts = Array.isArray(system.parts) ? system.parts : [];
  const contents = Array.isArray(copy.contents) ? [...copy.contents] : [];
  const first = asRecord(contents[0]);
  if (first?.role === "user" && Array.isArray(first.parts)) contents[0] = { ...first, parts: [...parts, ...first.parts] };
  else contents.unshift({ role: "user", parts });
  copy.contents = contents;
  return copy;
}

export function chatToGemini(kind: string, body: JsonMap): JsonMap {
  const model = googleModelRoute(kind, asString(body.model)).model;
  const converted = chatToAntigravity(withInlineParts(kind, { ...body, model }));
  const request: JsonMap = GEMMA_MODEL.test(model)
    ? withoutSystemInstruction(asRecord(converted.request) ?? {})
    : { ...(asRecord(converted.request) ?? {}) };
  const contents = (Array.isArray(request.contents) ? request.contents : [])
    .map(asRecord)
    .filter((content): content is JsonMap => content !== null);
  request.contents = withTurnBoundaries(withoutCallIds(contents));
  const generation = geminiGeneration(body, model, asRecord(request.generationConfig) ?? {});
  if (Object.keys(generation).length) request.generationConfig = generation;
  else delete request.generationConfig;
  return { model, request };
}

export function googlePayload(kind: string, path: string, body: JsonMap): JsonMap {
  if (kind === "vertex" && imagePath(path)) return imagenRequest(body);
  if (!chatPath(path)) return body;
  const route = googleModelRoute(kind, asString(body.model));
  if (route.route === "google") return chatToGemini(kind, body);
  if (route.route === "anthropic") return { ...chatToAnthropic({ ...body, model: route.model }), model: route.model };
  return { ...body, model: route.model };
}

export function googleWire(kind: string, path: string, payload: JsonMap): JsonMap {
  if (!chatPath(path)) return payload;
  const route = googleModelRoute(kind, asString(payload.model)).route;
  if (route === "google") return asRecord(payload.request) ?? {};
  if (route === "anthropic") {
    const wire: JsonMap = { ...payload, anthropic_version: VERTEX_ANTHROPIC_VERSION, stream: true };
    delete wire.model;
    return wire;
  }
  return payload;
}

export function blockedPromptLine(raw: string): string {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  if (!line.startsWith("data:")) return raw;
  const parsed = asRecord(parseJsonOrNull(line.slice(5).trim()));
  const response = asRecord(parsed?.response) ?? parsed;
  const candidates = response?.candidates;
  const blocked = asString(asRecord(response?.promptFeedback)?.blockReason);
  if (!response || !blocked || (Array.isArray(candidates) && candidates.length)) return raw;
  return `data: ${JSON.stringify({ ...response, candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" }] })}`;
}

class GeminiSseTranslator implements ChatSseTranslator {
  private inner: AntigravitySseTranslator;

  constructor(model: string) {
    this.inner = new AntigravitySseTranslator(model);
  }

  pushLine(line: string): string[] {
    return this.inner.pushLine(blockedPromptLine(line));
  }

  flush(): string | null {
    return this.inner.flush();
  }
}

export function googleResponse(kind: string, path: string, model: string, text: string, json: unknown): unknown {
  if (kind === "vertex" && imagePath(path)) return imagenImages(json);
  if (!chatPath(path)) return json;
  const route = googleModelRoute(kind, model).route;
  if (route === "google") return completionFromSse(new GeminiSseTranslator(model), text, model);
  if (route === "anthropic") return completionFromSse(new AnthropicSseTranslator(model), text, model);
  return json;
}

export function keepsThinkingBlocks(kind: string, model: string): boolean {
  return kind === "vertex" && vertexModelRoute(model).route === "anthropic";
}

export function googleStreamTranslator(kind: string, upstreamModel: string, model: string): ChatSseTranslator | null {
  const route = googleModelRoute(kind, upstreamModel).route;
  if (route === "google") return new GeminiSseTranslator(model);
  if (route === "anthropic") return new AnthropicSseTranslator(model);
  return null;
}
