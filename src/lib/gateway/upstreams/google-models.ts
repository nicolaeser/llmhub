import "server-only";
import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { geminiRoot, googlePath, VERTEX_EMBEDDING_MODEL, vertexEmbedContent } from "@/lib/gateway/upstreams/google";
import { VERTEX_API_VERSION, VERTEX_LIST_VERSION, vertexTarget } from "@/lib/gateway/upstreams/vertex-target";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { readJsonOr } from "@/lib/utils/json";
import type { JsonMap } from "@/types/gateway";
import type { DiscoveredModel, DiscoveredPage, UpstreamAuth } from "@/types/providers";

const MAX_PAGES = 10;
const GEMINI_PAGE_SIZE = 1000;
const VERTEX_PAGE_SIZE = 100;
const LIST_TIMEOUT_MS = 30_000;
const GEMINI_METHODS = new Set(["generateContent", "embedContent", "predict", "predictLongRunning"]);
const VERTEX_CHAT_GEMINI = /^gemini-/i;
const VERTEX_IMAGEN = /^imagen-/i;
const VERTEX_UNSUPPORTED = /-live|tts|native-audio/i;
const VERTEX_CLAUDE = /^claude-/i;
const CLAUDE_VERSION = /^[0-9]{8}$/;
const KEY_PROBE_MODEL = "gemini-2.5-flash";
const REJECTED_KEY_STATUSES = new Set([400, 401, 403]);
const EMBEDDING_PROBE_TEXT = "ping";
const EMBEDDING_PROBE_TIMEOUT_MS = 10_000;
const REJECTED_PROBE_STATUSES = new Set([400, 401, 403, 404]);

export const VERTEX_EMBEDDING_MODELS: readonly { id: string; name: string; context: number }[] = [
  { id: "gemini-embedding-001", name: "Gemini Embedding 001", context: 2048 },
  { id: "gemini-embedding-2", name: "Gemini Embedding 2", context: 8192 },
  { id: "text-embedding-005", name: "Text Embedding 005", context: 2048 },
  { id: "text-multilingual-embedding-002", name: "Text Multilingual Embedding 002", context: 2048 },
];

export const VERTEX_EXPRESS_MODELS: readonly { id: string; name: string }[] = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
  { id: "gemini-3-pro", name: "Gemini 3 Pro" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { id: "gemini-4-argon", name: "Gemini 4 Argon" },
];
const EXPRESS_CONTEXT = 1_048_576;

function discovered(id: string, name: string, ownedBy: string, contextLength = 0): DiscoveredModel {
  return { id, name: name || id, ownedBy, contextLength, costInputPer1k: 0, costOutputPer1k: 0, priceSource: "none" };
}

export function geminiModels(json: unknown): DiscoveredPage {
  const rec = asRecord(json);
  const models: DiscoveredModel[] = [];
  for (const raw of Array.isArray(rec?.models) ? rec.models : []) {
    const model = asRecord(raw);
    const id = asString(model?.name).replace(/^models\//, "");
    const methods = Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods.map(String) : [];
    if (!model || !id || !methods.some((method) => GEMINI_METHODS.has(method))) continue;
    models.push(discovered(id, asString(model.displayName), "google", asNumber(model.inputTokenLimit, 0)));
  }
  return { models, next: asString(rec?.nextPageToken) };
}

function vertexModelId(publisher: string, model: JsonMap): string {
  const id = asString(model.name).split("/").pop() ?? "";
  if (publisher === "google") {
    const kept = VERTEX_CHAT_GEMINI.test(id) || VERTEX_IMAGEN.test(id) || VERTEX_EMBEDDING_MODEL.test(id);
    return kept && !VERTEX_UNSUPPORTED.test(id) ? id : "";
  }
  if (!VERTEX_CLAUDE.test(id)) return "";
  const version = asString(model.versionId);
  return CLAUDE_VERSION.test(version) && !id.includes("@") ? `${id}@${version}` : id;
}

export function vertexModels(json: unknown, publisher: "google" | "anthropic"): DiscoveredPage {
  const rec = asRecord(json);
  const models: DiscoveredModel[] = [];
  for (const raw of Array.isArray(rec?.publisherModels) ? rec.publisherModels : []) {
    const model = asRecord(raw);
    const id = model ? vertexModelId(publisher, model) : "";
    if (id) models.push(discovered(id, id, publisher));
  }
  return { models, next: asString(rec?.nextPageToken) };
}

async function listPages(url: (token: string) => string, headers: Record<string, string>, parse: (json: unknown) => DiscoveredPage) {
  const out = new Map<string, DiscoveredModel>();
  let token = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(url(token), { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) }).catch((err: unknown) => {
      logger.warn("provider.google_models_unreachable", errorFields(err));
      throw new Error("UPSTREAM_FAILED");
    });
    const json = await readJsonOr(res, {});
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "UPSTREAM_AUTH" : "UPSTREAM_FAILED");
    const parsed = parse(json);
    for (const model of parsed.models) if (!out.has(model.id)) out.set(model.id, model);
    if (!parsed.next) break;
    token = parsed.next;
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function authHeaders(auth: UpstreamAuth): Record<string, string> {
  const headers: Record<string, string> = { ...auth.headers, Accept: "application/json" };
  if (auth.keyHeader) headers[auth.keyHeader] = auth.key;
  else headers.Authorization = `Bearer ${auth.key}`;
  return headers;
}

function pageQuery(size: number, token: string): string {
  const query = new URLSearchParams({ pageSize: String(size) });
  if (token) query.set("pageToken", token);
  return query.toString();
}

export async function fetchGeminiModels(baseUrl: string, auth: UpstreamAuth): Promise<DiscoveredModel[]> {
  const root = geminiRoot(baseUrl);
  return listPages((token) => `${root}/models?${pageQuery(GEMINI_PAGE_SIZE, token)}`, authHeaders(auth), geminiModels);
}

function vertexListUrl(baseUrl: string, publisher: string, token: string): string {
  const origin = new URL(baseUrl).origin;
  return `${origin}/${VERTEX_LIST_VERSION}/publishers/${publisher}/models?${pageQuery(VERTEX_PAGE_SIZE, token)}`;
}

export function expressModels(): DiscoveredModel[] {
  return VERTEX_EXPRESS_MODELS.map((model) => discovered(model.id, model.name, "google", EXPRESS_CONTEXT));
}

async function checkExpressKey(baseUrl: string, headers: Record<string, string>): Promise<void> {
  const url = `${new URL(baseUrl).origin}/${VERTEX_API_VERSION}/publishers/google/models/${KEY_PROBE_MODEL}:countTokens`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }),
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  }).catch((err: unknown) => {
    logger.warn("provider.google_models_unreachable", errorFields(err));
    throw new Error("UPSTREAM_FAILED");
  });
  if (REJECTED_KEY_STATUSES.has(res.status)) throw new Error("UPSTREAM_AUTH");
  if (!res.ok) throw new Error("UPSTREAM_FAILED");
}

async function fetchExpressModels(baseUrl: string, headers: Record<string, string>): Promise<DiscoveredModel[]> {
  const listed = await listPages((token) => vertexListUrl(baseUrl, "google", token), headers, (json) =>
    vertexModels(json, "google"),
  ).catch((err: unknown) => {
    logger.info("provider.vertex_express_list_unavailable", errorFields(err));
    return [];
  });
  const withoutImagen = listed.filter((model) => !VERTEX_IMAGEN.test(model.id));
  if (withoutImagen.length) return withoutImagen;
  await checkExpressKey(baseUrl, headers);
  return expressModels();
}

type ProbeOutcome = "served" | "rejected" | "unknown";

function embeddingProbeUrl(baseUrl: string, model: string): string | null {
  try {
    return googlePath("vertex", baseUrl, model, "/embeddings");
  } catch {
    return null;
  }
}

function embeddingProbeBody(model: string): string {
  if (vertexEmbedContent(model)) return JSON.stringify({ content: { parts: [{ text: EMBEDDING_PROBE_TEXT }] } });
  return JSON.stringify({ instances: [{ content: EMBEDDING_PROBE_TEXT }] });
}

async function probeEmbedding(baseUrl: string, model: string, headers: Record<string, string>): Promise<ProbeOutcome> {
  const url = embeddingProbeUrl(baseUrl, model);
  if (!url) return "rejected";
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: embeddingProbeBody(model),
    signal: AbortSignal.timeout(EMBEDDING_PROBE_TIMEOUT_MS),
  }).catch((err: unknown) => {
    logger.info("provider.vertex_embedding_probe_failed", { model, ...errorFields(err) });
    return null;
  });
  if (!res) return "unknown";
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) return "served";
  return REJECTED_PROBE_STATUSES.has(res.status) ? "rejected" : "unknown";
}

async function withEmbeddingModels(
  baseUrl: string,
  headers: Record<string, string>,
  listed: DiscoveredModel[],
  previous: ReadonlySet<string>,
): Promise<DiscoveredModel[]> {
  const known = new Set(listed.map((model) => model.id));
  const missing = VERTEX_EMBEDDING_MODELS.filter((model) => !known.has(model.id));
  const outcomes = await Promise.all(missing.map((model) => probeEmbedding(baseUrl, model.id, headers)));
  const probed = missing
    .filter((model, index) => outcomes[index] === "served" || (outcomes[index] === "unknown" && previous.has(model.id)))
    .map((model) => discovered(model.id, model.name, "google", model.context));
  return [...listed, ...probed];
}

export async function fetchVertexModels(
  baseUrl: string,
  auth: UpstreamAuth,
  previous: ReadonlySet<string> = new Set(),
): Promise<DiscoveredModel[]> {
  const headers = authHeaders(auth);
  return withEmbeddingModels(baseUrl, headers, await vertexListing(baseUrl, headers), previous);
}

async function vertexListing(baseUrl: string, headers: Record<string, string>): Promise<DiscoveredModel[]> {
  if (!vertexTarget(baseUrl)) return fetchExpressModels(baseUrl, headers);
  const gemini = await listPages((token) => vertexListUrl(baseUrl, "google", token), headers, (json) => vertexModels(json, "google"));
  const claude = await listPages(
    (token) => vertexListUrl(baseUrl, "anthropic", token),
    headers,
    (json) => vertexModels(json, "anthropic"),
  ).catch((err: unknown) => {
    logger.warn("provider.vertex_partner_models_failed", { publisher: "anthropic", ...errorFields(err) });
    return [];
  });
  return [...gemini, ...claude];
}
