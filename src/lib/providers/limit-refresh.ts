import "server-only";
import { isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { manualReadDue, pollAccounts, pollDue, refreshLimits } from "@/lib/gateway/upstreams/limit-store";
import { refreshResetView, resetViewDue, sharesUsageBlock } from "@/lib/gateway/upstreams/reset-redeem";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { withTimeout } from "@/lib/utils/timeout";
import type {
  LimitPollAccount,
  LimitRefreshOutcome,
  LimitRefreshOutcomes,
  LimitRefreshResult,
  StoredLimitSnapshot,
} from "@/types/providers";

const SWEEP_LIMIT = 32;
const SWEEP_CONCURRENCY = 4;
const VIEW_SWEEP_LIMIT = 8;
const KIND_SWEEP_LIMIT: Partial<Record<string, number>> = { claude: 4 };
export const MANUAL_REFRESH_WAIT_MS = 10_000;
export const MANUAL_KIND_CONCURRENCY = 4;
export const MANUAL_RUN_LIMIT_MS = 60_000;

type Lane = { running: number; waiting: (() => void)[] };

const manualLanes = new Map<string, Lane>();
const manualRuns = new Map<string, Promise<LimitRefreshOutcome | null>>();

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

async function pooled<T>(items: T[], size: number, work: (item: T) => Promise<boolean>): Promise<number> {
  const queue = items.values();
  let done = 0;
  const drain = async () => {
    for (const item of queue) if (await work(item)) done += 1;
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, drain));
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
  const started = Date.now();
  const current = () => now + Date.now() - started;
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
  const fetched = await pooled(due, SWEEP_CONCURRENCY, (account) => scheduledRefresh(account, current()));
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
  await pooled(views, SWEEP_CONCURRENCY, (account) => viewRefresh(account, false, current()));
  return fetched;
}

function manualOutcome(result: LimitRefreshResult, now: number): LimitRefreshOutcome | null {
  const snapshot = result.snapshot;
  if (!snapshot) return null;
  if (result.status === "fetched") return result.failure ? "failed" : "refreshed";
  if (result.status === "busy") {
    if (snapshot.leaseUntil !== null) return "pending";
    return snapshot.error ? "failed" : "refreshed";
  }
  return (snapshot.retryAt ?? 0) > now ? "blocked" : "recent";
}

export async function refreshAccountLimits(
  account: LimitPollAccount,
  now = Date.now(),
): Promise<LimitRefreshOutcome | null> {
  const result = await refreshLimits(account, { kind: "manual" }, { now });
  if (result.status === "gone") return null;
  if (!result.failure && isResetKind(account.kind)) await viewRefresh(account, true, now);
  return manualOutcome(result, now);
}

function manualLane(kind: string): Lane {
  const existing = manualLanes.get(kind);
  if (existing) return existing;
  const lane: Lane = { running: 0, waiting: [] };
  manualLanes.set(kind, lane);
  return lane;
}

async function inManualLane<T>(kind: string, work: () => Promise<T>): Promise<T> {
  const lane = manualLane(kind);
  if (lane.running < MANUAL_KIND_CONCURRENCY) lane.running += 1;
  else await new Promise<void>((resolve) => lane.waiting.push(resolve));
  try {
    return await work();
  } finally {
    const next = lane.waiting.shift();
    if (next) next();
    else lane.running -= 1;
  }
}

type ManualOptions = { waitMs?: number; runLimitMs?: number; now?: () => number; caps?: Partial<Record<string, number>> };

type CappedAccount = LimitPollAccount & { snapshot?: StoredLimitSnapshot | null };

export function overRefreshCap(
  accounts: CappedAccount[],
  caps: Partial<Record<string, number>>,
  running: ReadonlySet<string>,
  now: number,
): Set<string> {
  const held = new Set<string>();
  const open = new Map<string, number>();
  for (const account of accounts) {
    const cap = caps[account.kind] ?? 0;
    if (cap > 0 && running.has(account.id)) open.set(account.kind, (open.get(account.kind) ?? cap) - 1);
  }
  const due = accounts
    .filter(
      (account) =>
        (caps[account.kind] ?? 0) > 0 &&
        !running.has(account.id) &&
        manualReadDue(account.kind, account.snapshot ?? null, account.loginVersion, now),
    )
    .sort((a, b) => (a.snapshot?.checkedAt ?? 0) - (b.snapshot?.checkedAt ?? 0));
  for (const account of due) {
    const left = open.get(account.kind) ?? caps[account.kind] ?? 0;
    if (left > 0) open.set(account.kind, left - 1);
    else held.add(account.id);
  }
  return held;
}

function manualRefresh(account: LimitPollAccount, options: ManualOptions): Promise<LimitRefreshOutcome | null> {
  const running = manualRuns.get(account.id);
  if (running) return running;
  const clock = options.now ?? Date.now;
  const run = inManualLane(account.kind, () =>
    withTimeout(
      refreshAccountLimits(account, clock()),
      options.runLimitMs ?? MANUAL_RUN_LIMIT_MS,
      "the limits refresh did not finish in time",
    ),
  )
    .catch((err: unknown): LimitRefreshOutcome => {
      logger.warn("subscription.limits_refresh_failed", { providerId: account.id, kind: account.kind, ...errorFields(err) });
      return "failed";
    })
    .finally(() => manualRuns.delete(account.id));
  manualRuns.set(account.id, run);
  return run;
}

async function settledWithin(work: Promise<unknown>, waitMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([work, waited]);
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshAccountsLimits(
  accounts: CappedAccount[],
  options: ManualOptions = {},
): Promise<LimitRefreshOutcomes> {
  const held = options.caps
    ? overRefreshCap(accounts, options.caps, new Set(manualRuns.keys()), (options.now ?? Date.now)())
    : new Set<string>();
  const outcomes = new Map<string, LimitRefreshOutcome | null>(
    accounts.map((account) => [account.id, held.has(account.id) ? "capped" : "pending"]),
  );
  const runs = accounts
    .filter((account) => !held.has(account.id))
    .map(async (account) => {
      outcomes.set(account.id, await manualRefresh(account, options));
    });
  await settledWithin(Promise.all(runs), options.waitMs ?? MANUAL_REFRESH_WAIT_MS);
  return Object.fromEntries([...outcomes].flatMap(([id, outcome]) => (outcome ? [[id, outcome]] : [])));
}
