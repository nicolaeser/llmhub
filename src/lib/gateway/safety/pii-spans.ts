import { CREDENTIAL_ENTITIES, PII_CATALOG } from "@/lib/gateway/safety/pii";
import type { PiiModelSpan, PiiSpan } from "@/types/guardrails";

export const PII_DETECT_PATH = "/token-classification";
export const CHUNK_CHARS = 2_000;
export const CHUNK_OVERLAP = 200;

const TAG_PREFIX = /^[BIESLU]-/i;
const BREAK = /\s/;
const WORTH_DETECTING = /[\p{L}\p{N}]/u;
const CATALOG_IDS = new Set(PII_CATALOG.map((entity) => entity.id));
const PLACEHOLDER_TOKEN = new RegExp(`\\[(?:${[...CATALOG_IDS].join("|")})(?:_\\d+)?\\]`, "g");

export const MODEL_LABELS: Readonly<Record<string, string>> = {
  private_person: "PERSON",
  private_email: "EMAIL_ADDRESS",
  private_phone: "PHONE_NUMBER",
  private_address: "ADDRESS",
  private_url: "URL",
  private_date: "DATE_TIME",
  account_number: "ACCOUNT_NUMBER",
  secret: "SECRET",
  other_pii: "OTHER_PII",
  person: "PERSON",
  per: "PERSON",
  email: "EMAIL_ADDRESS",
  phone: "PHONE_NUMBER",
  address: "ADDRESS",
  street_address: "ADDRESS",
  date: "DATE_TIME",
  password: "SECRET",
};

export function modelEntity(label: string): string | null {
  const plain = label.trim().replace(TAG_PREFIX, "");
  const mapped = MODEL_LABELS[plain.toLowerCase()];
  if (mapped) return mapped;
  const id = plain.toUpperCase();
  return CATALOG_IDS.has(id) ? id : null;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function lastBreak(text: string, from: number, to: number): number {
  for (let i = to; i > from; i--) if (BREAK.test(text[i - 1] ?? "")) return i;
  return -1;
}

function nextBreak(text: string, from: number, to: number): number {
  for (let i = from; i < to; i++) if (BREAK.test(text[i] ?? "")) return i + 1;
  return -1;
}

export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): { start: number; end: number }[] {
  if (text.length <= size) return [{ start: 0, end: text.length }];
  const chunks: { start: number; end: number }[] = [];
  let start = 0;
  for (;;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const cut = lastBreak(text, start + Math.floor(size * 0.75), end);
      if (cut > start) end = cut;
      if (isLowSurrogate(text.charCodeAt(end))) end -= 1;
    }
    chunks.push({ start, end });
    if (end >= text.length) return chunks;
    let next = Math.max(end - overlap, start + 1);
    const snapped = nextBreak(text, next, next + Math.floor(overlap / 2));
    if (snapped > 0 && snapped < end) next = snapped;
    if (isLowSurrogate(text.charCodeAt(next))) next += 1;
    start = next;
  }
}

function spanRank(span: PiiSpan): [number, number, number, number] {
  return [CREDENTIAL_ENTITIES.has(span.entity) ? 1 : 0, span.end - span.start, span.source === "pattern" ? 1 : 0, span.score];
}

function outranks(a: PiiSpan, b: PiiSpan): boolean {
  const left = spanRank(a);
  const right = spanRank(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]!;
  }
  return false;
}

export function mergePiiSpans(spans: readonly PiiSpan[]): PiiSpan[] {
  const sorted = spans.filter((span) => span.end > span.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: PiiSpan[] = [];
  let cluster: PiiSpan[] = [];
  let end = -1;
  const flush = () => {
    if (!cluster.length) return;
    const winner = cluster.reduce((best, span) => (outranks(span, best) ? span : best));
    merged.push({
      entity: winner.entity,
      start: cluster[0]!.start,
      end,
      score: Math.max(...cluster.map((span) => span.score)),
      source: winner.source,
    });
  };
  for (const span of sorted) {
    if (cluster.length && span.start < end) {
      cluster.push(span);
      end = Math.max(end, span.end);
      continue;
    }
    flush();
    cluster = [span];
    end = span.end;
  }
  flush();
  return merged;
}

export function worthDetecting(text: string): boolean {
  return text.length >= 2 && WORTH_DETECTING.test(text.replace(PLACEHOLDER_TOKEN, ""));
}

export function overlapsPlaceholder(text: string, span: Pick<PiiSpan, "start" | "end">): boolean {
  for (const token of text.matchAll(PLACEHOLDER_TOKEN)) {
    const start = token.index ?? 0;
    if (span.start < start + token[0].length && start < span.end) return true;
  }
  return false;
}

function utf16Index(text: string): (point: number) => number | undefined {
  if (!/[\uD800-\uDFFF]/.test(text)) return (point) => (point <= text.length ? point : undefined);
  const offsets = [0];
  let at = 0;
  for (const char of text) {
    at += char.length;
    offsets.push(at);
  }
  return (point) => offsets[point];
}

function spanOf(raw: unknown, toUtf16: (point: number) => number | undefined): PiiModelSpan | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const label = [item.entity_group, item.entity, item.label].find((value) => typeof value === "string");
  if (typeof label !== "string" || !Number.isInteger(item.start) || !Number.isInteger(item.end)) return null;
  const entity = modelEntity(label);
  const start = toUtf16(item.start as number);
  const end = toUtf16(item.end as number);
  if (!entity || start === undefined || end === undefined || start >= end) return null;
  const score = typeof item.score === "number" && item.score >= 0 && item.score <= 1 ? item.score : 1;
  return { entity, start, end, score };
}

function isSpanList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
}

export function parseDetections(json: unknown, inputs: readonly string[]): PiiModelSpan[][] | null {
  const lists = inputs.length === 1 && isSpanList(json) ? [json] : json;
  if (!Array.isArray(lists) || lists.length !== inputs.length || !lists.every(isSpanList)) return null;
  return lists.map((list, index) => {
    const toUtf16 = utf16Index(inputs[index] ?? "");
    return (list as unknown[]).flatMap((raw) => spanOf(raw, toUtf16) ?? []);
  });
}

export type Slots = { acquire(deadline: number): Promise<() => void>; readonly waiting: number };

export function createSlots(limit: number, maxWaiting: number): Slots {
  let active = 0;
  const queue: { grant: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  const release = () => {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
      return;
    }
    active -= 1;
  };
  return {
    get waiting() {
      return queue.length;
    },
    acquire(deadline) {
      if (active < limit) {
        active += 1;
        return Promise.resolve(release);
      }
      if (queue.length >= maxWaiting) return Promise.reject(Object.assign(new Error("PII detector queue is full"), { code: "PII_DETECTOR_BUSY" }));
      return new Promise((resolve, reject) => {
        const entry = {
          grant: () => resolve(release),
          timer: setTimeout(() => {
            queue.splice(queue.indexOf(entry), 1);
            reject(Object.assign(new Error("PII detector timed out in its queue"), { code: "PII_DETECTOR_TIMEOUT" }));
          }, Math.max(0, deadline - Date.now())),
        };
        queue.push(entry);
      });
    },
  };
}
