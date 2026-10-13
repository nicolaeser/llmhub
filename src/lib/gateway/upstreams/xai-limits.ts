import { asRecord, asString } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";
import type { LimitWindow, SubscriptionLimits } from "@/types/providers";

export const XAI_BILLING_WEEKLY_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export const XAI_BILLING_MONTHLY_URL = "https://cli-chat-proxy.grok.com/v1/billing";
export const XAI_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

const XAI_CLIENT_VERSION = "1.0.46";
const WEEK_SECONDS = 7 * 86_400;
const MONTH_SECONDS = 30 * 86_400;

export function xaiLimitHeaders(): Record<string, string> {
  return {
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": XAI_CLIENT_VERSION,
    "User-Agent": `grok-pager/${XAI_CLIENT_VERSION} grok-shell/${XAI_CLIENT_VERSION} (linux; x86_64)`,
    Accept: "*/*",
  };
}

function cents(value: unknown): number | null {
  const raw = asRecord(value)?.val ?? value;
  const number = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function percentOf(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return (Math.min(used, limit) / limit) * 100;
}

function span(period: JsonMap | null, fallback: number): number {
  const start = Date.parse(asString(period?.start));
  const end = Date.parse(asString(period?.end));
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round((end - start) / 1000) : fallback;
}

function window(percent: number, windowSeconds: number, end: unknown): LimitWindow {
  const usedPercent = Math.min(100, Math.max(0, percent));
  const resetsAt = Date.parse(asString(end));
  return {
    scope: "",
    usedPercent,
    windowSeconds,
    resetsAt: Number.isFinite(resetsAt) ? new Date(resetsAt).toISOString() : null,
    limitReached: usedPercent >= 100,
  };
}

export function xaiLimits(
  weekly: JsonMap | null,
  monthly: JsonMap | null,
  plan: string,
  now = Date.now(),
): SubscriptionLimits {
  const windows: LimitWindow[] = [];
  const week = asRecord(weekly?.config);
  const weekPeriod = asRecord(week?.currentPeriod ?? week?.current_period);
  const weekPercent = week?.creditUsagePercent ?? week?.credit_usage_percent;
  if (week && weekPercent !== undefined && weekPercent !== null && Number.isFinite(Number(weekPercent))) {
    windows.push(window(Number(weekPercent), span(weekPeriod, WEEK_SECONDS), weekPeriod?.end ?? week.billingPeriodEnd));
  }
  const month = asRecord(monthly?.config);
  const monthPercent = percentOf(cents(month?.used), cents(month?.monthlyLimit ?? month?.monthly_limit));
  if (month && monthPercent !== null) {
    const start = month.billingPeriodStart ?? month.billing_period_start;
    const end = month.billingPeriodEnd ?? month.billing_period_end;
    windows.push(window(monthPercent, span({ start, end }, MONTH_SECONDS), end));
  }
  const cap = cents(month?.onDemandCap ?? month?.on_demand_cap);
  const used = cents(month?.onDemandUsed ?? month?.on_demand_used);
  const monthlyLimit = cents(month?.monthlyLimit ?? month?.monthly_limit);
  const spent = cents(month?.used);
  const onDemandUsed = used ?? (spent !== null && monthlyLimit !== null ? Math.max(0, spent - monthlyLimit) : null);
  return {
    plan,
    windows,
    credits: null,
    resetCredits: null,
    extraUsage:
      cap !== null && cap > 0 && onDemandUsed !== null
        ? { usedCents: onDemandUsed, limitCents: cap, percent: percentOf(onDemandUsed, cap) }
        : null,
    fetchedAt: new Date(now).toISOString(),
  };
}

export function xaiPlan(settings: JsonMap | null): string {
  return asString(settings?.subscription_tier_display) || asString(settings?.subscriptionTierDisplay);
}
