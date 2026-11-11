import { asRecord, asString } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";
import type { LimitWindow } from "@/types/providers";

const FIVE_HOURS_SECONDS = 5 * 3_600;
const WEEK_SECONDS = 7 * 86_400;
const MAX_QUOTA_BUCKETS = 32;
const MAX_BUCKET_ID_LENGTH = 64;
const MAX_LABEL_LENGTH = 80;
const BUCKET_SPANS = [
  { window: "5h", suffix: "-5h", seconds: FIVE_HOURS_SECONDS },
  { window: "weekly", suffix: "-weekly", seconds: WEEK_SECONDS },
] as const;

type QuotaShare = Pick<LimitWindow, "usedPercent" | "resetsAt" | "limitReached">;

export function quotaShare(quota: JsonMap): QuotaShare {
  const resetsAt = asString(quota.resetTime);
  const remaining = quota.remainingFraction;
  const exhausted = typeof remaining !== "number" && resetsAt !== "";
  const fraction = typeof remaining === "number" ? Math.min(1, Math.max(0, remaining)) : exhausted ? 0 : 1;
  const usedPercent = Math.round((1 - fraction) * 1000) / 10;
  const reset = Date.parse(resetsAt);
  return {
    usedPercent,
    resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
    limitReached: usedPercent >= 100,
  };
}

function bucketSeconds(bucket: JsonMap, id: string): number | null {
  const window = asString(bucket.window).toLowerCase();
  const byWindow = BUCKET_SPANS.find((span) => span.window === window);
  if (byWindow) return byWindow.seconds;
  const lowered = id.toLowerCase();
  return BUCKET_SPANS.find((span) => lowered.endsWith(span.suffix))?.seconds ?? null;
}

function reportsQuota(bucket: JsonMap): boolean {
  return typeof bucket.remainingFraction === "number" || asString(bucket.resetTime) !== "";
}

function bucketWindow(bucket: JsonMap, groupName: string): LimitWindow | null {
  const id = asString(bucket.bucketId).trim();
  if (!id || id.length > MAX_BUCKET_ID_LENGTH || bucket.disabled === true || !reportsQuota(bucket)) return null;
  const windowSeconds = bucketSeconds(bucket, id);
  if (windowSeconds === null) return null;
  return {
    scope: id,
    exactScope: true,
    accountBucket: id,
    label: (groupName || asString(bucket.displayName).trim() || id).slice(0, MAX_LABEL_LENGTH),
    windowSeconds,
    ...quotaShare(bucket),
  };
}

export function antigravityQuotaBuckets(json: unknown): LimitWindow[] {
  const groups = asRecord(json)?.groups;
  if (!Array.isArray(groups)) return [];
  const windows: LimitWindow[] = [];
  const seen = new Set<string>();
  for (const rawGroup of groups.slice(0, MAX_QUOTA_BUCKETS)) {
    const group = asRecord(rawGroup);
    if (!group || !Array.isArray(group.buckets)) continue;
    const name = asString(group.displayName).trim();
    const own: LimitWindow[] = [];
    for (const rawBucket of group.buckets.slice(0, MAX_QUOTA_BUCKETS)) {
      const bucket = asRecord(rawBucket);
      const window = bucket ? bucketWindow(bucket, name) : null;
      if (!window || seen.has(window.scope)) continue;
      seen.add(window.scope);
      own.push(window);
    }
    windows.push(...own.sort((a, b) => a.windowSeconds - b.windowSeconds));
    if (windows.length >= MAX_QUOTA_BUCKETS) break;
  }
  return windows.slice(0, MAX_QUOTA_BUCKETS);
}
