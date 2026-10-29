import type { Messages } from "@/types/i18n";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

export function mergeMessages(base: Messages, override: Messages): Messages {
  const merged: Messages = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isUnsafeKey(key)) continue;
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = mergeMessages(current, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export function assignMessagePath(target: Messages, dottedPath: string, payload: unknown) {
  const segments = dottedPath.split(".");
  if (segments.some(isUnsafeKey)) return;
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    const owned: Messages = isPlainObject(existing) ? { ...existing } : {};
    cursor[segment] = owned;
    cursor = owned;
  }
  const leaf = segments[segments.length - 1];
  const existing = cursor[leaf];
  cursor[leaf] = isPlainObject(existing) && isPlainObject(payload) ? mergeMessages(existing, payload) : payload;
}

export function messageAt(messages: Messages, dottedPath: string): unknown {
  let cursor: unknown = messages;
  for (const segment of dottedPath.split(".")) {
    if (isUnsafeKey(segment) || !isPlainObject(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}
