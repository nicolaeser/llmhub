import "server-only";
import prisma from "@/lib/db/prisma";
import { antigravityLimits } from "@/lib/gateway/upstreams/antigravity";
import { fetchAvailableModels } from "@/lib/gateway/upstreams/antigravity-api";
import { reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import { CLAUDE_OAUTH_BETAS } from "@/lib/gateway/upstreams/claude";
import { CODEX_USAGE_URL } from "@/lib/gateway/upstreams/codex";
import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { providerAuth, sessionAuth } from "@/lib/gateway/upstreams/credentials";
import { GateError } from "@/lib/gateway/errors";
import { retryAfterMs } from "@/lib/gateway/upstreams/reset-credits";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { notifyLive } from "@/lib/updates/live-topics";
import { readJsonOr } from "@/lib/utils/json";
import {
  XAI_BILLING_MONTHLY_URL,
  XAI_BILLING_WEEKLY_URL,
  XAI_SETTINGS_URL,
  xaiLimitHeaders,
  xaiLimits,
  xaiPlan,
} from "@/lib/gateway/upstreams/xai-limits";
import type { JsonMap } from "@/types/gateway";
import type {
  LimitAccount,
  LimitErrorCode,
  LimitFetchFailure,
  LimitWindow,
  SignInCheck,
  SignInKind,
  SignInSession,
  SubscriptionLimits,
  UpstreamAuth,
} from "@/types/providers";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_FIVE_HOUR_SECONDS = 5 * 3_600;
const CLAUDE_WEEK_SECONDS = 7 * 86_400;
const CLAUDE_WINDOWS = [
  { key: "five_hour", scope: "", windowSeconds: CLAUDE_FIVE_HOUR_SECONDS },
  { key: "seven_day", scope: "", windowSeconds: CLAUDE_WEEK_SECONDS },
  { key: "seven_day_sonnet", scope: "Sonnet", windowSeconds: CLAUDE_WEEK_SECONDS },
  { key: "seven_day_opus", scope: "Opus", windowSeconds: CLAUDE_WEEK_SECONDS },
  { key: "seven_day_oauth_apps", scope: "OAuth apps", windowSeconds: CLAUDE_WEEK_SECONDS },
  { key: "seven_day_cowork", scope: "Cowork", windowSeconds: CLAUDE_WEEK_SECONDS },
  { key: "iguana_necktie", scope: "Fable", windowSeconds: CLAUDE_WEEK_SECONDS },
] as const;
const CLAUDE_CREDIT_POOL_SCOPE = "Cloud sessions";
const LIMITS_TIMEOUT_MS = 15_000;
const TOO_MANY_REQUESTS = 429;

const cache = new Map<string, SubscriptionLimits>();

export class LimitsFetchError extends Error {
  readonly retryAfterMs: number | null;

  constructor(code: LimitErrorCode, retryAfterMs: number | null = null, options?: ErrorOptions) {
    super(code, options);
    this.name = "LimitsFetchError";
    this.retryAfterMs = retryAfterMs;
  }
}

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
  const resets = asRecord(payload.rate_limit_reset_credits);
  const available = Math.max(0, Math.floor(asNumber(resets?.available_count, 0)));
  return {
    plan: asString(payload.plan_type),
    windows,
    credits:
      credits && (credits.unlimited === true || credits.has_credits === true)
        ? { unlimited: credits.unlimited === true, balance: asString(credits.balance) }
        : null,
    resetCredits: resets
      ? { available, applicable: Math.max(0, Math.floor(asNumber(resets.applicable_available_count, available))) }
      : null,
    extraUsage: null,
    fetchedAt: new Date(now).toISOString(),
  };
}

function claudeWindow(scope: string, windowSeconds: number, usage: JsonMap): LimitWindow {
  const usedPercent = Math.min(100, Math.max(0, asNumber(usage.utilization ?? usage.percent, 0)));
  const resetsAt = Date.parse(asString(usage.resets_at));
  return {
    scope,
    usedPercent,
    windowSeconds,
    resetsAt: Number.isFinite(resetsAt) ? new Date(resetsAt).toISOString() : null,
    limitReached: usedPercent >= 100,
  };
}

function claudeExtraUsage(raw: unknown): SubscriptionLimits["extraUsage"] {
  const extra = asRecord(raw);
  if (!extra || extra.is_enabled !== true) return null;
  const utilization = extra.utilization;
  return {
    usedCents: Math.max(0, asNumber(extra.used_credits, 0)),
    limitCents: Math.max(0, asNumber(extra.monthly_limit, 0)),
    percent: typeof utilization === "number" ? Math.min(100, Math.max(0, utilization)) : null,
  };
}

function scopeKey(scope: string): string {
  return scope.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function claudeLimits(payload: JsonMap, plan: string, now = Date.now()): SubscriptionLimits {
  const windows: LimitWindow[] = [];
  for (const spec of CLAUDE_WINDOWS) {
    const usage = asRecord(payload[spec.key]);
    if (!usage) continue;
    const creditPool = spec.key === "iguana_necktie" && usage.limit_dollars !== undefined;
    windows.push(
      claudeWindow(creditPool ? CLAUDE_CREDIT_POOL_SCOPE : spec.scope, creditPool ? 0 : spec.windowSeconds, usage),
    );
  }
  const known = new Set(windows.map((window) => scopeKey(window.scope)));
  for (const raw of Array.isArray(payload.limits) ? payload.limits : []) {
    const limit = asRecord(raw);
    const model = asString(asRecord(asRecord(limit?.scope)?.model)?.display_name);
    if (!limit || limit.kind !== "weekly_scoped" || !model || known.has(scopeKey(model))) continue;
    if (typeof limit.percent !== "number") continue;
    known.add(scopeKey(model));
    windows.push(claudeWindow(model, CLAUDE_WEEK_SECONDS, limit));
  }
  return {
    plan,
    windows,
    credits: null,
    resetCredits: null,
    extraUsage: claudeExtraUsage(payload.extra_usage),
    fetchedAt: new Date(now).toISOString(),
  };
}

async function usageAuth(provider: LimitAccount) {
  return providerAuth(provider).catch((error: unknown) => {
    throw error instanceof GateError ? new LimitsFetchError("SIGN_IN_EXPIRED", null, { cause: error }) : error;
  });
}

type UsageReply = { status: number; json: JsonMap | null; retryAfterMs: number | null };

async function getJson(url: string, key: string, headers: Record<string, string>): Promise<UsageReply> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", ...headers, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS),
      redirect: "error",
    });
    return {
      status: res.status,
      json: res.ok ? asRecord(await readJsonOr(res, null)) : null,
      retryAfterMs: retryAfterMs(res.headers.get("retry-after"), Date.now()),
    };
  } catch {
    return { status: 0, json: null, retryAfterMs: null };
  }
}

function failOn(replies: UsageReply[]): void {
  const limited = replies.find((reply) => reply.status === TOO_MANY_REQUESTS);
  if (limited) throw new LimitsFetchError("UPSTREAM_RATE_LIMITED", limited.retryAfterMs);
  if (replies.some((reply) => reply.status === 401 || reply.status === 403)) throw new LimitsFetchError("UPSTREAM_AUTH");
}

async function fetchUsage(
  provider: LimitAccount,
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<JsonMap> {
  const auth = await usageAuth(provider);
  const reply = await getJson(url, auth.key, { ...auth.headers, ...extraHeaders });
  failOn([reply]);
  if (!reply.json) throw new LimitsFetchError("UPSTREAM_FAILED");
  return reply.json;
}

async function fetchXaiLimits(provider: LimitAccount): Promise<SubscriptionLimits> {
  const auth = await usageAuth(provider);
  const headers = { ...auth.headers, ...xaiLimitHeaders() };
  const [weekly, monthly, settings] = await Promise.all([
    getJson(XAI_BILLING_WEEKLY_URL, auth.key, headers),
    getJson(XAI_BILLING_MONTHLY_URL, auth.key, headers),
    getJson(XAI_SETTINGS_URL, auth.key, headers),
  ]);
  const billing = [weekly, monthly];
  failOn(billing);
  if (billing.every((result) => result.status === 0 || result.status >= 500)) throw new LimitsFetchError("UPSTREAM_FAILED");
  return xaiLimits(weekly.json, monthly.json, xaiPlan(settings.json) || (await storedPlan(provider.id)));
}

async function storedPlan(providerId: string): Promise<string> {
  const row = await prisma.providerLogin.findUnique({ where: { providerId }, select: { plan: true } });
  return row?.plan ?? "";
}

async function fetchAntigravityLimits(provider: LimitAccount): Promise<SubscriptionLimits> {
  const auth = await usageAuth(provider);
  const { status, json, retryAfter } = await fetchAvailableModels(auth);
  failOn([{ status, json: null, retryAfterMs: retryAfterMs(retryAfter, Date.now()) }]);
  if (status < 200 || status >= 300) throw new LimitsFetchError("UPSTREAM_FAILED");
  return antigravityLimits(json, await storedPlan(provider.id));
}

async function probeStatus(kind: SignInKind, auth: UpstreamAuth): Promise<number> {
  if (kind === "antigravity") return (await fetchAvailableModels(auth)).status;
  if (kind === "claude") {
    return (await getJson(CLAUDE_USAGE_URL, auth.key, { ...auth.headers, "anthropic-beta": CLAUDE_OAUTH_BETAS.join(",") }))
      .status;
  }
  if (kind === "grok_build") {
    return (await getJson(XAI_BILLING_WEEKLY_URL, auth.key, { ...auth.headers, ...xaiLimitHeaders() })).status;
  }
  return (await getJson(CODEX_USAGE_URL, auth.key, auth.headers)).status;
}

export async function checkSignInSession(kind: SignInKind, session: SignInSession): Promise<SignInCheck> {
  const status = await probeStatus(kind, sessionAuth(kind, session));
  if (status === 401 || status === 403) return "rejected";
  if ((status >= 200 && status < 300) || status === 429) return "valid";
  return "unreachable";
}

export async function fetchSubscriptionLimits(provider: LimitAccount): Promise<SubscriptionLimits | null> {
  if (!reportsLimits(provider.kind)) return null;
  if (provider.kind === "antigravity") return fetchAntigravityLimits(provider);
  if (provider.kind === "claude") {
    const json = await fetchUsage(provider, CLAUDE_USAGE_URL, { "anthropic-beta": CLAUDE_OAUTH_BETAS.join(",") });
    return claudeLimits(json, await storedPlan(provider.id));
  }
  if (provider.kind === "grok_build") return fetchXaiLimits(provider);
  return codexLimits(await fetchUsage(provider, CODEX_USAGE_URL));
}

export function limitFailure(error: unknown): LimitFetchFailure {
  if (error instanceof LimitsFetchError) {
    return { code: error.message as LimitErrorCode, retryAfterMs: error.retryAfterMs };
  }
  return { code: "UPSTREAM_FAILED", retryAfterMs: null };
}

export function limitsSnapshot(providerId: string): SubscriptionLimits | null {
  return cache.get(providerId) ?? null;
}

export function rememberLimits(providerId: string, limits: SubscriptionLimits): void {
  const current = cache.get(providerId);
  if (current && Date.parse(current.fetchedAt) > Date.parse(limits.fetchedAt)) return;
  cache.set(providerId, limits);
}

export function dropCachedLimits(providerId: string): void {
  cache.delete(providerId);
}

export async function forgetLimits(providerId: string, now = Date.now()): Promise<void> {
  cache.delete(providerId);
  try {
    const written = await prisma.providerLimitSnapshot.updateMany({
      where: { providerId },
      data: { fetchedAt: null, error: "", failures: 0, nextAt: new Date(now), version: { increment: 1 } },
    });
    if (written.count) notifyLive("limits");
  } catch (err) {
    logger.warn("subscription.limits_forget_failed", { providerId, ...errorFields(err) });
  }
}
