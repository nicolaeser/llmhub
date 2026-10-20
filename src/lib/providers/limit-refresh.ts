import "server-only";
import { isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { pollAccounts, pollDue, refreshLimits } from "@/lib/gateway/upstreams/limit-store";
import { refreshResetView, resetViewDue, sharesUsageBlock } from "@/lib/gateway/upstreams/reset-redeem";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type { LimitPollAccount } from "@/types/providers";

const SWEEP_LIMIT = 32;
const SWEEP_CONCURRENCY = 4;
const VIEW_SWEEP_LIMIT = 8;
const KIND_SWEEP_LIMIT: Partial<Record<string, number>> = { claude: 4 };

function withinSweep<T extends { kind: string }>(items: T[], limit: number, used: Map<string, number>): T[] {
  const picked: T[] = [];
  for (const item of items) {
    if (picked.length >= limit) break;
    const count = used.get(item.kind) ?? 0;
    if (count >= (KIND_SWEEP_LIMIT[item.kind] ?? Infinity)) continue;
    used.set(item.kind, count + 1);
    picked.push(item);
  }
  return picked;
}

async function inBatches<T>(items: T[], size: number, work: (item: T) => Promise<boolean>): Promise<number> {
  let done = 0;
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.all(items.slice(i, i + size).map(work));
    done += results.filter(Boolean).length;
  }
  return done;
}

async function scheduledRefresh(account: LimitPollAccount, now: number): Promise<boolean> {
  try {
    return (await refreshLimits(account, { kind: "scheduled" }, { now })).status === "fetched";
  } catch (err) {
    logger.warn("subscription.limits_refresh_failed", { providerId: account.id, kind: account.kind, ...errorFields(err) });
    return false;
  }
}

async function viewRefresh(account: LimitPollAccount, refresh: boolean, now: number): Promise<boolean> {
  try {
    return await refreshResetView(account, { refresh, now });
  } catch (err) {
    logger.warn("provider.reset_view_failed", { providerId: account.id, kind: account.kind, ...errorFields(err) });
    return false;
  }
}

export async function refreshDueLimits(now = Date.now()): Promise<number> {
  const accounts = await pollAccounts();
  const reads = new Map<string, number>();
  const due = withinSweep(
    accounts
      .filter((account) => pollDue(account.snapshot, account.loginVersion, now))
      .sort((a, b) => (a.snapshot?.nextAt ?? 0) - (b.snapshot?.nextAt ?? 0)),
    SWEEP_LIMIT,
    reads,
  );
  const polled = new Set(due.map((account) => account.id));
  const fetched = await inBatches(due, SWEEP_CONCURRENCY, (account) => scheduledRefresh(account, now));
  const views = withinSweep(
    accounts.filter(
      (account) =>
        !polled.has(account.id) &&
        isResetKind(account.kind) &&
        account.snapshot?.limits &&
        resetViewDue(account.kind, account.snapshot.resetsAt, false, now) &&
        !(sharesUsageBlock(account.kind) && (account.snapshot.retryAt ?? 0) > now),
    ),
    VIEW_SWEEP_LIMIT,
    reads,
  );
  await inBatches(views, SWEEP_CONCURRENCY, (account) => viewRefresh(account, false, now));
  return fetched;
}

export async function refreshAccountLimits(account: LimitPollAccount, now = Date.now()): Promise<void> {
  const result = await refreshLimits(account, { kind: "manual" }, { now });
  if (result.status === "gone" || !isResetKind(account.kind)) return;
  await viewRefresh(account, true, now);
}

export async function refreshAccountsLimits(accounts: LimitPollAccount[], now = Date.now()): Promise<void> {
  await inBatches(accounts, SWEEP_CONCURRENCY, async (account) => {
    try {
      await refreshAccountLimits(account, now);
      return true;
    } catch (err) {
      logger.warn("subscription.limits_refresh_failed", { providerId: account.id, kind: account.kind, ...errorFields(err) });
      return false;
    }
  });
}
