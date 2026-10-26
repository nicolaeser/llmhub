import { asRecord } from "@/lib/gateway/core";
import { labelKey, labelValue, MAX_REQUEST_LABELS } from "@/lib/usage/labels";
import type { LabelCandidates } from "@/types/gateway";
import type { RequestLabel } from "@/types/usage";

export const LABEL_HEADER_PREFIX = "x-llmhub-label-";
export const LABELS_HEADER = "x-llmhub-labels";
export const MAX_LABEL_CANDIDATES = 32;

const TAG_SEPARATOR = /[:=]/;

function addCandidate(target: LabelCandidates, rawKey: unknown, rawValue: unknown): void {
  if (Object.keys(target).length >= MAX_LABEL_CANDIDATES) return;
  const key = labelKey(rawKey);
  const value = labelValue(rawValue);
  if (key && value && !(key in target)) target[key] = value;
}

export function percentDecoded(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function headerLabels(headers: Headers): LabelCandidates {
  const labels: LabelCandidates = {};
  for (const [name, value] of headers) {
    if (name.startsWith(LABEL_HEADER_PREFIX)) {
      addCandidate(labels, name.slice(LABEL_HEADER_PREFIX.length), percentDecoded(value));
    }
  }
  for (const entry of (headers.get(LABELS_HEADER) ?? "").split(",")) {
    const at = entry.indexOf("=");
    if (at > 0) addCandidate(labels, entry.slice(0, at), percentDecoded(entry.slice(at + 1)));
  }
  return labels;
}

export function bodyLabels(body: unknown): LabelCandidates {
  const labels: LabelCandidates = {};
  const rec = asRecord(body);
  if (!rec) return labels;
  for (const [key, value] of Object.entries(asRecord(rec.metadata) ?? {})) addCandidate(labels, key, value);
  for (const tag of Array.isArray(rec.tags) ? rec.tags : []) {
    if (typeof tag !== "string") continue;
    const at = tag.search(TAG_SEPARATOR);
    if (at > 0) addCandidate(labels, tag.slice(0, at), tag.slice(at + 1));
  }
  return labels;
}

export function mergeLabels(base: LabelCandidates | undefined, extra: LabelCandidates): LabelCandidates {
  const merged: LabelCandidates = { ...base };
  for (const [key, value] of Object.entries(extra)) addCandidate(merged, key, value);
  return merged;
}

export function pickLabels(candidates: LabelCandidates, allowed: ReadonlySet<string>): RequestLabel[] {
  return Object.keys(candidates)
    .filter((key) => allowed.has(key))
    .sort()
    .slice(0, MAX_REQUEST_LABELS)
    .map((key) => ({ key, value: candidates[key]! }));
}
