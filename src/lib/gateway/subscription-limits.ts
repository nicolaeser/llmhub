import "server-only";
import { reportsLimits } from "@/lib/gateway/catalog";
import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { providerAuth } from "@/lib/gateway/credentials";
import { GateError } from "@/lib/gateway/errors";
import type { JsonMap } from "@/types/gateway";
import type { LimitWindow, SubscriptionLimits } from "@/types/providers";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const LIMITS_TTL_MS = 60_000;
const FORCED_REFRESH_MS = 10_000;
const LIMITS_TIMEOUT_MS = 15_000;

const cache = new Map<string, { at: number; limits: SubscriptionLimits }>();

function limitWindows(scope: string, rateLimit: unknown, now: number): LimitWindow[] {
  const limit = asRecord(rateLimit);
  if (!limit) return [];
  const reached = limit.limit_reached === true || limit.allowed === false;
  const out: LimitWindow[] = [];
  for (const raw of [limit.primary_window, limit.secondary_window]) {
    const window = asRecord(raw);
    if (!window) continue;
    const resetAt = asNumber(window.reset_at, 0);
    const resetAfter = asNumber(window.reset_after_seconds, -1);
    const resetsAt = resetAt > 0 ? resetAt * 1000 : resetAfter >= 0 ? now + resetAfter * 1000 : 0;
    const usedPercent = Math.min(100, Math.max(0, asNumber(window.used_percent, 0)));
    out.push({
      scope,
      usedPercent,
      windowSeconds: Math.max(0, asNumber(window.limit_window_seconds, 0)),
      resetsAt: resetsAt > 0 ? new Date(resetsAt).toISOString() : null,
      limitReached: reached && usedPercent >= 100,
    });
  }
  return out;
}

export function codexLimits(payload: JsonMap, now = Date.now()): SubscriptionLimits {
  const windows = limitWindows("", payload.rate_limit, now);
  for (const raw of Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : []) {
    const extra = asRecord(raw);
    if (!extra) continue;
    windows.push(...limitWindows(asString(extra.limit_name) || asString(extra.metered_feature), extra.rate_limit, now));
  }
  const credits = asRecord(payload.credits);
  return {
    plan: asString(payload.plan_type),
    windows,
    credits:
      credits && (credits.unlimited === true || credits.has_credits === true)
        ? { unlimited: credits.unlimited === true, balance: asString(credits.balance) }
        : null,
    fetchedAt: new Date(now).toISOString(),
  };
}

async function fetchCodexLimits(provider: { id: string; kind: string; apiKey: string }): Promise<SubscriptionLimits> {
  const auth = await providerAuth(provider).catch((error: unknown) => {
    throw error instanceof GateError ? new Error("SIGN_IN_EXPIRED", { cause: error }) : error;
  });
  const res = await fetch(CODEX_USAGE_URL, {
    headers: { ...auth.headers, Authorization: `Bearer ${auth.key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS),
    redirect: "error",
  }).catch(() => {
    throw new Error("UPSTREAM_FAILED");
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "UPSTREAM_AUTH" : "UPSTREAM_FAILED");
  const json = asRecord(await res.json().catch(() => null));
  if (!json) throw new Error("UPSTREAM_FAILED");
  return codexLimits(json);
}

export async function subscriptionLimits(
  provider: { id: string; kind: string; apiKey: string },
  opts: { force?: boolean } = {},
): Promise<SubscriptionLimits | null> {
  if (!reportsLimits(provider.kind)) return null;
  const cached = cache.get(provider.id);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < (opts.force ? FORCED_REFRESH_MS : LIMITS_TTL_MS)) return cached.limits;
  const limits = await fetchCodexLimits(provider);
  cache.set(provider.id, { at: Date.now(), limits });
  return limits;
}
