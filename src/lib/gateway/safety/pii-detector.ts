import "server-only";
import { createHash } from "node:crypto";
import { toGateError } from "@/lib/gateway/access/gate";
import { systemPrincipal } from "@/lib/gateway/access/system-principal";
import { meter } from "@/lib/gateway/billing/meter";
import { forwardToModel } from "@/lib/gateway/dispatch/upstream";
import { GateError } from "@/lib/gateway/errors";
import {
  applyPiiSpans,
  defaultEntityIds,
  mapScannedStrings,
  piiPatternSpans,
  redactCredentials,
  redactJSON,
  redactPii,
} from "@/lib/gateway/safety/pii";
import {
  chunkText,
  createSlots,
  mergePiiSpans,
  overlapsPlaceholder,
  parseDetections,
  PII_DETECT_PATH,
  worthDetecting,
} from "@/lib/gateway/safety/pii-spans";
import { withActiveVault, type PiiVault } from "@/lib/gateway/safety/pii-vault";
import { logger } from "@/lib/logging/logger";
import { featureModel } from "@/lib/models/feature-models";
import { getPiiDetector } from "@/lib/settings/enterprise";
import type { Principal } from "@/types/gateway";
import type { PiiModelSpan, PiiPolicy, PiiSpan } from "@/types/guardrails";

export const PII_DETECT_CONCURRENCY = 2;
export const PII_DETECT_QUEUE = 32;
export const PII_DETECT_MAX_CHARS = 200_000;
export const PII_BATCH_INPUTS = 16;
export const PII_BATCH_CHARS = 16_000;

const CACHE_LIMIT = 2_000;
const CACHE_TTL_MS = 10 * 60_000;
const FAILURE_LOG_MS = 60_000;

const slots = createSlots(PII_DETECT_CONCURRENCY, PII_DETECT_QUEUE);
const cache = new Map<string, { spans: PiiModelSpan[]; at: number }>();
const failureLogged = new Map<string, number>();

export class PiiDetectorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PiiDetectorError";
  }
}

type Piece = { owner: string; offset: number; text: string };

function cacheKey(model: string, text: string): string {
  return createHash("sha256").update(model).update("\0").update(text).digest("hex");
}

function cached(model: string, text: string): PiiModelSpan[] | null {
  const key = cacheKey(model, text);
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.spans;
}

function remember(model: string, text: string, spans: PiiModelSpan[]): void {
  cache.set(cacheKey(model, text), { spans, at: Date.now() });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearPiiDetectorCache(): void {
  cache.clear();
  failureLogged.clear();
}

function batchesOf(pieces: Piece[]): Piece[][] {
  const batches: Piece[][] = [];
  let current: Piece[] = [];
  let chars = 0;
  for (const piece of pieces) {
    if (current.length && (current.length >= PII_BATCH_INPUTS || chars + piece.text.length > PII_BATCH_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(piece);
    chars += piece.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function classify(model: string, principal: Principal, inputs: string[], deadline: number): Promise<PiiModelSpan[][]> {
  const release = await slots.acquire(deadline);
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PiiDetectorError("PII_DETECTOR_TIMEOUT");
    const usage = meter(principal, model, { model });
    let hit;
    try {
      hit = await forwardToModel([model], principal, PII_DETECT_PATH, { model, inputs }, { pool: "internal", timeoutMs: remaining });
    } catch (err) {
      await usage.fail(err);
      throw err;
    }
    const lists = parseDetections(hit.json, inputs);
    if (!lists) {
      const err = new GateError(502, "upstream_error", "the redaction model answered in an unknown format");
      await usage.fail(err);
      throw err;
    }
    await usage.ok(hit, {}, {});
    return lists;
  } finally {
    release();
  }
}

export async function detectPiiSpans(
  texts: readonly string[],
  options: { model: string; principal: Principal; timeoutMs: number; useCache?: boolean },
): Promise<Map<string, PiiModelSpan[]>> {
  const { model, principal } = options;
  const useCache = options.useCache ?? true;
  const deadline = Date.now() + options.timeoutMs;
  const result = new Map<string, PiiModelSpan[]>();
  const pending: string[] = [];
  for (const text of new Set(texts)) {
    const hit = useCache ? cached(model, text) : null;
    if (hit) result.set(text, hit);
    else pending.push(text);
  }
  if (!pending.length) return result;
  if (pending.reduce((sum, text) => sum + text.length, 0) > PII_DETECT_MAX_CHARS) throw new PiiDetectorError("PII_DETECTOR_TOO_LARGE");
  const found = new Map<string, PiiSpan[]>(pending.map((text) => [text, []]));
  const pieces = pending.flatMap((text) =>
    chunkText(text).map(({ start, end }) => ({ owner: text, offset: start, text: text.slice(start, end) })),
  );
  await Promise.all(
    batchesOf(pieces).map(async (batch) => {
      const lists = await classify(model, principal, batch.map((piece) => piece.text), deadline);
      batch.forEach((piece, index) => {
        const spans = found.get(piece.owner);
        for (const span of lists[index] ?? []) {
          spans?.push({ ...span, start: span.start + piece.offset, end: span.end + piece.offset, source: "model" });
        }
      });
    }),
  );
  for (const [text, spans] of found) {
    const merged = mergePiiSpans(spans).map(({ entity, start, end, score }) => ({ entity, start, end, score }));
    if (useCache) remember(model, text, merged);
    result.set(text, merged);
  }
  return result;
}

function noteFailure(model: string, err: unknown): void {
  const code = err instanceof PiiDetectorError ? err.code : toGateError(err).code;
  const key = `${model}\0${code}`;
  const now = Date.now();
  if (now - (failureLogged.get(key) ?? 0) < FAILURE_LOG_MS) return;
  failureLogged.set(key, now);
  const status = err instanceof PiiDetectorError ? 0 : toGateError(err).status;
  logger.warn("pii.detector_failed", { model, code, status });
}

export function piiDetectorUnavailable(): GateError {
  return new GateError(503, "pii_detector_unavailable", "PII detection is unavailable, so the request was blocked");
}

export async function redactWithPolicy(
  value: unknown,
  pii: PiiPolicy,
  found: Set<string>,
  vault: PiiVault | null,
): Promise<unknown> {
  const entities = pii.entities.length ? pii.entities : defaultEntityIds();
  if (pii.detector !== "model" && pii.detector !== "both") return redactJSON(value, entities, "", found, vault);
  const credentialFound = new Set<string>();
  const cleaned = new Map<string, string>();
  mapScannedStrings(value, (text) => {
    if (!cleaned.has(text)) cleaned.set(text, redactCredentials(text, entities, credentialFound));
    return text;
  });
  const candidates = [...new Set(cleaned.values())].filter(worthDetecting);
  const [model, settings] = await Promise.all([featureModel("pii", "redaction"), getPiiDetector()]);
  let detected = new Map<string, PiiModelSpan[]>();
  try {
    if (!model) throw new PiiDetectorError("PII_MODEL_MISSING");
    if (candidates.length) {
      detected = await detectPiiSpans(candidates, {
        model,
        principal: systemPrincipal("pii"),
        timeoutMs: settings.timeout_seconds * 1000,
      });
    }
  } catch (err) {
    noteFailure(model, err);
    if (pii.failure === "block") throw piiDetectorUnavailable();
    return redactJSON(value, entities, "", found, vault);
  }
  for (const id of credentialFound) found.add(id);
  const enabled = new Set(entities);
  return withActiveVault(vault, () =>
    mapScannedStrings(value, (text) => {
      const clean = cleaned.get(text) ?? text;
      const spans: PiiSpan[] = (detected.get(clean) ?? [])
        .filter((span) => enabled.has(span.entity) && !overlapsPlaceholder(clean, span))
        .map((span) => ({ ...span, source: "model" }));
      if (pii.detector === "model") return applyPiiSpans(clean, mergePiiSpans(spans), found);
      const patterns = piiPatternSpans(clean, entities);
      if (!patterns) return redactPii(applyPiiSpans(clean, mergePiiSpans(spans), found), entities, found);
      return applyPiiSpans(clean, mergePiiSpans([...spans, ...patterns]), found);
    }),
  );
}
