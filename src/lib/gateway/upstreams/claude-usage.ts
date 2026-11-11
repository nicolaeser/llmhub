import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";
import type { LimitWindow, SubscriptionLimits } from "@/types/providers";

export const CLAUDE_FIVE_HOUR_SECONDS = 5 * 3_600;
export const CLAUDE_WEEK_SECONDS = 7 * 86_400;
export const CLAUDE_MODEL_LIMIT_KEY = "iguana_necktie";
export const CLAUDE_SCOPED_LIMIT_KEY = "weekly_scoped";
export const CLAUDE_WINDOWS = [
  { key: "five_hour", scope: "", windowSeconds: CLAUDE_FIVE_HOUR_SECONDS },
  { key: "seven_day", scope: "", windowSeconds: CLAUDE_WEEK_SECONDS },
  { key: "seven_day_sonnet", scope: "Sonnet", windowSeconds: CLAUDE_WEEK_SECONDS },
  { key: "seven_day_opus", scope: "Opus", windowSeconds: CLAUDE_WEEK_SECONDS },
  { key: "seven_day_oauth_apps", scope: "OAuth apps", windowSeconds: CLAUDE_WEEK_SECONDS },
  { key: "seven_day_cowork", scope: "Cowork", windowSeconds: CLAUDE_WEEK_SECONDS },
  { key: CLAUDE_MODEL_LIMIT_KEY, scope: "Fable", windowSeconds: CLAUDE_WEEK_SECONDS },
] as const;
const CLAUDE_CREDIT_POOL_SCOPE = "Cloud sessions";
const FULL_PERCENT = 100;

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(FULL_PERCENT, Math.max(0, value)) : null;
}

function claudeWindow(key: string, scope: string, windowSeconds: number, usage: JsonMap): LimitWindow {
  const usedPercent = Math.min(FULL_PERCENT, Math.max(0, asNumber(usage.utilization ?? usage.percent, 0)));
  const resetsAt = Date.parse(asString(usage.resets_at));
  return {
    key,
    scope,
    usedPercent,
    windowSeconds,
    resetsAt: Number.isFinite(resetsAt) ? new Date(resetsAt).toISOString() : null,
    limitReached: usedPercent >= FULL_PERCENT,
  };
}

export function claudeExtraUsage(raw: unknown): SubscriptionLimits["extraUsage"] {
  const extra = asRecord(raw);
  if (!extra || extra.is_enabled !== true) return null;
  const utilization = extra.utilization;
  return {
    usedCents: Math.max(0, asNumber(extra.used_credits, 0)),
    limitCents: Math.max(0, asNumber(extra.monthly_limit, 0)),
    percent: typeof utilization === "number" ? Math.min(FULL_PERCENT, Math.max(0, utilization)) : null,
  };
}

export function scopeKey(scope: string): string {
  return scope.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function weeklyShares(payload: JsonMap): Map<number, { used: number | null; allowance: number | null }> {
  const shares = new Map<number, { used: number | null; allowance: number | null }>();
  for (const raw of Array.isArray(payload.weekly_scoped_shares) ? payload.weekly_scoped_shares : []) {
    const share = asRecord(raw);
    const index = share?.limit_index;
    if (!share || typeof index !== "number" || !Number.isInteger(index) || index < 0) continue;
    shares.set(index, {
      used: percent(share.used_percent_of_weekly),
      allowance: percent(share.allowance_percent_of_weekly),
    });
  }
  return shares;
}

export function claudeWindows(payload: JsonMap): LimitWindow[] {
  const windows: LimitWindow[] = [];
  for (const spec of CLAUDE_WINDOWS) {
    const usage = asRecord(payload[spec.key]);
    if (!usage) continue;
    const creditPool = spec.key === CLAUDE_MODEL_LIMIT_KEY && usage.limit_dollars !== undefined;
    windows.push(
      claudeWindow(
        spec.key,
        creditPool ? CLAUDE_CREDIT_POOL_SCOPE : spec.scope,
        creditPool ? 0 : spec.windowSeconds,
        usage,
      ),
    );
  }
  const shares = weeklyShares(payload);
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  limits.forEach((raw, index) => {
    const limit = asRecord(raw);
    const model = asString(asRecord(asRecord(limit?.scope)?.model)?.display_name);
    if (!limit || limit.kind !== CLAUDE_SCOPED_LIMIT_KEY || !model) return;
    let window = windows.find((item) => scopeKey(item.scope) === scopeKey(model));
    if (!window) {
      if (typeof limit.percent !== "number") return;
      window = claudeWindow(CLAUDE_SCOPED_LIMIT_KEY, model, CLAUDE_WEEK_SECONDS, limit);
      windows.push(window);
    }
    const share = shares.get(index);
    if (share?.used !== null && share?.used !== undefined) window.usedPercentOfWeekly = share.used;
    if (share?.allowance !== null && share?.allowance !== undefined) window.allowancePercentOfWeekly = share.allowance;
  });
  return windows;
}
