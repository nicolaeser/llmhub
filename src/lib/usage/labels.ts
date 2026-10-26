import type { RequestLabel } from "@/types/usage";

export const MAX_REQUEST_LABELS = 8;
export const MAX_LABEL_KEYS = 20;
export const MAX_LABEL_KEY_LENGTH = 40;
export const MAX_LABEL_VALUE_LENGTH = 100;

const LABEL_KEY = /^[a-z][a-z0-9_]*$/;
const CONTROL = /\p{Cc}/gu;
const SPACES = /\s+/g;

export function labelKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replaceAll("-", "_");
  return key.length <= MAX_LABEL_KEY_LENGTH && LABEL_KEY.test(key) ? key : null;
}

export function labelValue(raw: unknown): string | null {
  if (typeof raw === "number" && !Number.isFinite(raw)) return null;
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return null;
  const value = String(raw).normalize("NFC").replace(CONTROL, " ").replace(SPACES, " ").trim();
  if (!value) return null;
  const points = [...value];
  return points.length > MAX_LABEL_VALUE_LENGTH ? points.slice(0, MAX_LABEL_VALUE_LENGTH).join("").trimEnd() : value;
}

export function storedLabel(label: RequestLabel): string {
  return `${label.key}:${label.value}`;
}

export function labelOf(stored: string): RequestLabel | null {
  const at = stored.indexOf(":");
  if (at <= 0) return null;
  return { key: stored.slice(0, at), value: stored.slice(at + 1) };
}

export function labelsOf(stored: readonly string[]): RequestLabel[] {
  return stored.flatMap((entry) => {
    const label = labelOf(entry);
    return label ? [label] : [];
  });
}

export function labelRecord(labels: readonly RequestLabel[]): Record<string, string> {
  return Object.fromEntries(labels.map((label) => [label.key, label.value]));
}

export function labelText(labels: readonly RequestLabel[]): string {
  return labels.map(storedLabel).join("; ");
}

export function parseLabelFilter(text: unknown): RequestLabel | null {
  if (typeof text !== "string") return null;
  const at = text.indexOf(":");
  if (at <= 0) return null;
  const key = labelKey(text.slice(0, at));
  const value = labelValue(text.slice(at + 1));
  return key && value ? { key, value } : null;
}

export function labelKeyList(raw: unknown): { keys: string[]; invalid: string[] } {
  const entries = Array.isArray(raw) ? raw : [];
  const keys = new Set<string>();
  const invalid: string[] = [];
  for (const entry of entries) {
    const key = labelKey(entry);
    if (key) keys.add(key);
    else invalid.push(typeof entry === "string" ? entry : String(entry));
  }
  return { keys: [...keys].sort(), invalid };
}

export function cleanLabelKeys(raw: unknown): string[] {
  const { keys, invalid } = labelKeyList(raw);
  if (invalid.length) throw new Error("LABEL_KEY_INVALID");
  if (keys.length > MAX_LABEL_KEYS) throw new Error("LABEL_KEYS_LIMIT");
  return keys;
}
