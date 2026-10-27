import { SUB_ADD_PATH } from "@/lib/http/public-path";
import { errorSummary } from "@/lib/logging/format";
import type { SentryExceptionValues } from "@/types/sentry";

const FILTERED = "[Filtered]";
const SUB_ADD_TOKEN_IN_PATH = new RegExp(`(${SUB_ADD_PATH}/(?:manage/)?)[A-Za-z0-9_-]+`, "g");
const URL_PARAMETER_VALUE = /([?&#][^\s?&#="'<>]+=)[^\s&#"'<>]*/g;
const UNSCRUBBED_KEYS = new Set(["stacktrace", "debug_meta", "sdkProcessingMetadata"]);

export function scrubText(text: string): string {
  return text
    .replace(SUB_ADD_TOKEN_IN_PATH, `$1${FILTERED}`)
    .replace(URL_PARAMETER_VALUE, `$1${FILTERED}`);
}

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubText(value);
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (UNSCRUBBED_KEYS.has(key)) continue;
    const scrubbed = scrubValue(record[key], seen);
    if (scrubbed !== record[key]) record[key] = scrubbed;
  }
  return value;
}

export function scrubEvent<T extends object>(event: T): T {
  scrubValue(event, new WeakSet());
  for (const entry of (event as SentryExceptionValues).exception?.values ?? []) {
    if (typeof entry.value === "string") entry.value = errorSummary(entry.value);
  }
  return event;
}
