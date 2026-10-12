import "server-only";
import { usageFromUnknown } from "@/lib/gateway/billing";
import { asNumber, asRecord } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { allowModel, applyGuardrails, modelChain, withTrace } from "@/lib/gateway/gate";
import { meter } from "@/lib/gateway/meter";
import { forwardToModel } from "@/lib/gateway/upstream";
import { ocrText } from "@/lib/rag/extract";
import { parseEmbedding } from "@/lib/rag/vectors";
import type { JsonMap, Principal, ProxyFirstResult, Usage } from "@/types/gateway";

export const RERANK_PATH = "/rerank";

export function rerankUsage(json: unknown): Partial<Usage> {
  const rec = asRecord(json);
  const usage = asRecord(rec?.usage);
  const billed = asRecord(asRecord(rec?.meta)?.billed_units);
  const tokens =
    asNumber(usage?.prompt_tokens) ||
    asNumber(usage?.input_tokens) ||
    asNumber(usage?.total_tokens) ||
    asNumber(billed?.input_tokens);
  const cost = asNumber(usage?.cost, -1);
  return {
    prompt_tokens: tokens,
    completion_tokens: 0,
    total_tokens: tokens,
    ...(cost >= 0 ? { cost } : {}),
  };
}

export function rerankResults(json: unknown): { index: number; score: number }[] {
  const rec = asRecord(json);
  const list = Array.isArray(rec?.results) ? rec.results : Array.isArray(rec?.data) ? rec.data : Array.isArray(json) ? json : [];
  return list.flatMap((raw) => {
    const item = asRecord(raw);
    if (!item || typeof item.index !== "number") return [];
    const score = typeof item.relevance_score === "number" ? item.relevance_score : asNumber(item.score, NaN);
    return Number.isFinite(score) ? [{ index: item.index, score }] : [];
  });
}

export async function forwardModelCall(input: {
  principal: Principal;
  model: string;
  path: string;
  body: JsonMap;
  usage: (json: unknown) => Partial<Usage>;
}): Promise<ProxyFirstResult> {
  const { principal, model } = input;
  allowModel(principal, model);
  const { body: clean } = await applyGuardrails(input.body, principal);
  const aliases = modelChain(principal, model, clean);
  const usage = meter(principal, model, input.body);
  try {
    const hit = await forwardToModel(aliases, principal, input.path, clean);
    await usage.ok(hit, input.usage(hit.json));
    return hit;
  } catch (err) {
    await usage.fail(err);
    throw err;
  }
}

function embeddingUsage(json: unknown): Partial<Usage> {
  return usageFromUnknown(asRecord(json)?.usage, json);
}

export async function embedTexts(input: {
  principal: Principal;
  endpoint: string;
  model: string;
  dimensions: number;
  texts: string[];
}): Promise<Float32Array[]> {
  const body: JsonMap = { model: input.model, input: input.texts, encoding_format: "float" };
  if (input.dimensions > 0) body.dimensions = input.dimensions;
  const hit = await forwardModelCall({
    principal: withTrace(input.principal, input.endpoint),
    model: input.model,
    path: "/embeddings",
    body,
    usage: embeddingUsage,
  });
  const data = asRecord(hit.json)?.data;
  const rows = Array.isArray(data) ? data.map((item) => asRecord(item)).filter((item) => item !== null) : [];
  const vectors: (Float32Array | null)[] = new Array(input.texts.length).fill(null);
  rows.forEach((row, position) => {
    const index = typeof row.index === "number" ? row.index : position;
    if (index >= 0 && index < vectors.length) vectors[index] = parseEmbedding(row.embedding);
  });
  if (vectors.some((vector) => vector === null)) {
    throw new GateError(502, "upstream_error", `embedding model ${input.model} returned ${rows.length} vectors for ${input.texts.length} inputs`);
  }
  return vectors as Float32Array[];
}

export async function ocrDocument(input: {
  principal: Principal;
  endpoint: string;
  model: string;
  document: JsonMap;
}): Promise<string> {
  const hit = await forwardModelCall({
    principal: withTrace(input.principal, input.endpoint),
    model: input.model,
    path: "/ocr",
    body: { model: input.model, document: input.document },
    usage: embeddingUsage,
  });
  return ocrText(hit.json);
}

export async function rerankTexts(input: {
  principal: Principal;
  endpoint: string;
  model: string;
  query: string;
  documents: string[];
}): Promise<{ index: number; score: number }[]> {
  const hit = await forwardModelCall({
    principal: withTrace(input.principal, input.endpoint),
    model: input.model,
    path: RERANK_PATH,
    body: { model: input.model, query: input.query, documents: input.documents, top_n: input.documents.length },
    usage: rerankUsage,
  });
  return rerankResults(hit.json);
}
