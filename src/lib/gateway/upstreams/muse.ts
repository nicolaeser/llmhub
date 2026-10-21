import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { isMuseSignature } from "@/lib/gateway/protocols/reasoning-signature";
import { chatToCodex, codexCompletion, CodexSseTranslator } from "@/lib/gateway/upstreams/codex";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import type { JsonMap, ResponsesStreamOptions } from "@/types/gateway";
import type { DiscoveredModel, LimitWindow } from "@/types/providers";

export const MUSE_CLIENT_ID = "1031625952748946";
export const MUSE_DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/";
export const MUSE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
export const MUSE_MINT_URL = "https://api.meta.ai/muse-code/key";
export const MUSE_AUTH_USER_AGENT = "muse-code/1.0.2";
export const MUSE_USER_AGENT =
  "muse-build/1.3.0 (interactive; macos-aarch64; build ac7280f2aca67769d1455a8847bb502b617d50f6)";
export const MUSE_CLIENT_TAG = "tbh:tui";
export const MUSE_KEY_EXPIRES_AT = Date.UTC(9999, 0, 1);
export const MUSE_USAGE_EVENT = "response.subscription_usage";

const DEFAULT_WINDOW_MINUTES = 300;
const WEEK_SECONDS = 7 * 86_400;
const MUSE_CONTEXT = 1_048_576;
const WONDER_CONTEXT = 1_007_997;

const MUSE_MODEL_LIST: [id: string, name: string, context: number][] = [
  ["muse-wonder-1.0", "Muse Wonder 1.0", WONDER_CONTEXT],
  ["muse-wonder-1.0-contributor", "Muse Wonder 1.0 Contributor", WONDER_CONTEXT],
  ["muse-wonder-full-1.0", "Muse Wonder Full 1.0", WONDER_CONTEXT],
  ["muse-wonder-full-1.0-contributor", "Muse Wonder Full 1.0 Contributor", WONDER_CONTEXT],
  ["muse-spark-1.3", "Muse Spark 1.3", MUSE_CONTEXT],
  ["muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", MUSE_CONTEXT],
  ["muse-spark-1.2", "Muse Spark 1.2", MUSE_CONTEXT],
  ["muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", MUSE_CONTEXT],
  ["muse-spark-1.1", "Muse Spark 1.1", MUSE_CONTEXT],
];

export function museModelsUrl(): string {
  return `${PROVIDER_CATALOG.find((spec) => spec.kind === "muse_code")?.default_base_url ?? ""}/models`;
}

export function museHeaders(): Record<string, string> {
  return { "User-Agent": MUSE_USER_AGENT, "X-Client-Id": MUSE_CLIENT_TAG };
}

export function museModels(): DiscoveredModel[] {
  return MUSE_MODEL_LIST.map(([id, name, contextLength]) => ({
    id,
    name,
    ownedBy: "meta",
    contextLength,
    costInputPer1k: 0,
    costOutputPer1k: 0,
    priceSource: "none",
  }));
}

export function chatToMuse(body: JsonMap): JsonMap {
  const payload = chatToCodex(body, isMuseSignature);
  delete payload.service_tier;
  delete payload.access_programs;
  return payload;
}

function usageWindow(raw: unknown, windowSeconds: number): LimitWindow | null {
  const window = asRecord(raw);
  if (!window || window.used_percent === undefined || window.used_percent === null) return null;
  const used = Number(window.used_percent);
  if (!Number.isFinite(used)) return null;
  const usedPercent = Math.min(100, Math.max(0, used));
  const resetsAt = asNumber(window.resets_at, 0);
  return {
    scope: "",
    usedPercent,
    windowSeconds,
    resetsAt: resetsAt > 0 ? new Date(resetsAt * 1000).toISOString() : null,
    limitReached: usedPercent >= 100,
  };
}

export function museUsageWindows(event: JsonMap): LimitWindow[] {
  const subscription = asRecord(event.subscription);
  if (!subscription) return [];
  const rolling = asRecord(subscription.window);
  const minutes = asNumber(rolling?.window_duration_mins, DEFAULT_WINDOW_MINUTES);
  return [
    usageWindow(rolling, Math.round((minutes > 0 ? minutes : DEFAULT_WINDOW_MINUTES) * 60)),
    usageWindow(subscription.weekly, WEEK_SECONDS),
  ].filter((window): window is LimitWindow => window !== null);
}

export function isMuseUsageEvent(type: string, data: JsonMap): boolean {
  return type === MUSE_USAGE_EVENT || (!type && asRecord(data.subscription) !== null);
}

export function museFailure(data: JsonMap, now = Date.now()): GateError {
  const error = asRecord(data.error) ?? asRecord(asRecord(data.response)?.error) ?? {};
  const code = Number(error.code);
  const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502;
  const resetsAt = asNumber(error.resets_at, 0) * 1000;
  return new GateError(
    status,
    "upstream_error",
    asString(error.message) || asString(data.message) || "upstream response failed",
    { retryAt: status === 429 && resetsAt > now ? resetsAt : null },
  );
}

export function museStreamOptions(onUsage?: (windows: LimitWindow[]) => void): ResponsesStreamOptions {
  return {
    isSignature: isMuseSignature,
    failure: (data) => museFailure(data),
    onEvent: (type, data) => {
      if (!onUsage || !isMuseUsageEvent(type, data)) return;
      const windows = museUsageWindows(data);
      if (windows.length) onUsage(windows);
    },
  };
}

export function museTranslator(model: string, onUsage?: (windows: LimitWindow[]) => void): CodexSseTranslator {
  return new CodexSseTranslator(model, museStreamOptions(onUsage));
}

export function museCompletion(text: string, model: string, onUsage?: (windows: LimitWindow[]) => void): JsonMap {
  return codexCompletion(text, model, museStreamOptions(onUsage));
}
