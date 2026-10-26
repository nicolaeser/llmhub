import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db/prisma";
import { isPrismaCode } from "@/lib/auth/errors";
import { asRecord } from "@/lib/gateway/core";
import { isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { accountRecoveryAt, hasExhaustedQuota } from "@/lib/gateway/routing/quota";
import { limitsFromTraffic, PROVIDER_CATALOG, reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import {
  claudeHeaderWindows,
  isObservedWindow,
  limitsUpdatedAt,
  observedWindowsBefore,
  observedChanged,
  observedFlipped,
  observedTime,
  withObservedWindows,
} from "@/lib/gateway/upstreams/observed-limits";
import { parseResetState, resetCreditsView, resetStateKey } from "@/lib/gateway/upstreams/reset-state";
import {
  dropCachedLimits,
  fetchSubscriptionLimits,
  LimitsFetchError,
  limitFailure,
  limitsSnapshot,
  rememberLimits,
} from "@/lib/gateway/upstreams/subscription-limits";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { notifyLive } from "@/lib/updates/live-topics";
import type {
  LimitAccount,
  LimitFetchFailure,
  LimitPollAccount,
  LimitRefreshMode,
  LimitRefreshResult,
  LimitSnapshot,
  LimitWindow,
  StoredLimitSnapshot,
  SubscriptionLimits,
} from "@/types/providers";
import type { ResetCredits, ResetState } from "@/types/resets";

export const LIMITS_POLL_MS = 3 * 60_000;
export const CLAUDE_POLL_MS = 30 * 60_000;
export const CLAUDE_TRAFFIC_POLL_MS = 2 * 3_600_000;
export const POLL_JITTER = 0.15;
export const MIN_POLL_GAP_MS = 60_000;
export const RESET_GRACE_MS = 30_000;
export const RESET_GRACE_JITTER_MS = 15_000;
export const MANUAL_REFRESH_GAP_MS = 60_000;
export const CLAUDE_MANUAL_REFRESH_GAP_MS = 5 * 60_000;
export const ERROR_BACKOFF_MS = 60_000;
export const AUTH_BACKOFF_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;
export const RATE_LIMIT_WAIT_MS = 15 * 60_000;
export const MAX_RATE_LIMIT_WAIT_MS = 2 * 3_600_000;
export const RATE_LIMIT_JITTER = 0.1;
export const OBSERVED_WRITE_GAP_MS = 30_000;
export const OBSERVED_REFRESH_MS = 5 * 60_000;
const LIMIT_LEASE_MS = 60_000;
const HYDRATE_MS = 15_000;
const LEASE_WAIT_MS = 5_000;
const LEASE_POLL_MS = 250;
const NUDGE_GAP_MS = 60_000;
const OBSERVED_WRITE_ATTEMPTS = 3;
const RATE_LIMITED = "UPSTREAM_RATE_LIMITED";

const LIMIT_ACCOUNT_KINDS = PROVIDER_CATALOG.filter((spec) => reportsLimits(spec.kind)).map((spec) => spec.kind);

const ACTIVE_ACCOUNT = { kind: { in: LIMIT_ACCOUNT_KINDS }, login: { is: { status: "active" } } };

const hydratedAt = new Map<string, number>();
const hydrating = new Map<string, Promise<void>>();
const nudgedAt = new Map<string, number>();
const observedAt = new Map<string, number>();
const streamedAt = new Map<string, number>();
const observedWrites = new Map<string, { at: number; windows: LimitWindow[] }>();
const observedChains = new Map<string, Promise<boolean>>();

export function recordStreamTraffic(providerId: string, now = Date.now()): void {
  streamedAt.set(providerId, now);
}

export function isStreamingActive(providerId: string, now = Date.now(), windowMs = LIMITS_POLL_MS): boolean {
  const stream = streamedAt.get(providerId) ?? -Infinity;
  const observed = observedAt.get(providerId) ?? -Infinity;
  return Math.max(stream, observed) > now - windowMs;
}

type SnapshotRow = {
  providerId: string;
  limits: unknown;
  resets: unknown;
  resetsAt: Date | null;
  error: string;
  fetchedAt: Date | null;
  checkedAt: Date | null;
  nextAt: Date;
  retryAt: Date | null;
  failures: number;
  loginVersion: number;
  leaseUntil: Date | null;
  version: number;
};

function time(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function json(value: object): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function limitsOf(value: unknown): SubscriptionLimits | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.windows) || typeof record.fetchedAt !== "string") return null;
  return record as unknown as SubscriptionLimits;
}

function resetsOf(value: unknown): ResetCredits | null {
  const record = asRecord(value);
  if (!record || typeof record.available !== "number" || typeof record.applicable !== "number") return null;
  return record as unknown as ResetCredits;
}

export function storedOf(row: SnapshotRow): StoredLimitSnapshot {
  return {
    providerId: row.providerId,
    limits: limitsOf(row.limits),
    resets: resetsOf(row.resets),
    resetsAt: time(row.resetsAt),
    error: row.error,
    fetchedAt: time(row.fetchedAt),
    checkedAt: time(row.checkedAt),
    nextAt: row.nextAt.getTime(),
    retryAt: time(row.retryAt),
    failures: row.failures,
    loginVersion: row.loginVersion,
    leaseUntil: time(row.leaseUntil),
    version: row.version,
  };
}

export function jittered(ms: number, random: () => number, spread = POLL_JITTER): number {
  return Math.round(ms * (1 + (random() * 2 - 1) * spread));
}

export function pollInterval(kind: string, streaming = false): number {
  return streaming && kind === "claude" ? CLAUDE_POLL_MS : LIMITS_POLL_MS;
}

export function manualRefreshGap(kind: string): number {
  return kind === "claude" ? CLAUDE_MANUAL_REFRESH_GAP_MS : MANUAL_REFRESH_GAP_MS;
}

export function nextPollAt(
  kind: string,
  limits: SubscriptionLimits | null,
  now: number,
  random: () => number = Math.random,
  streaming = false,
): number {
  const isStreaming =
    streaming ||
    (kind === "claude" &&
      limits !== null &&
      now - observedTime(limits) < LIMITS_POLL_MS &&
      !hasExhaustedQuota(limits, now));
  const interval = pollInterval(kind, isStreaming);
  const regular = now + jittered(interval, random);
  const recovery = accountRecoveryAt(limits, now);
  if (recovery === null) return regular;
  const afterReset = recovery + RESET_GRACE_MS + Math.round(random() * RESET_GRACE_JITTER_MS);
  return Math.max(now + MIN_POLL_GAP_MS, Math.min(regular, afterReset));
}

export function rateLimitWait(failures: number, retryAfterMs: number | null): number {
  const escalated = Math.min(MAX_RATE_LIMIT_WAIT_MS, RATE_LIMIT_WAIT_MS * 2 ** Math.max(0, failures - 1));
  return Math.max(retryAfterMs ?? 0, escalated);
}

export function failureDelay(failure: LimitFetchFailure, failures: number, random: () => number = Math.random): number {
  if (failure.code === RATE_LIMITED) {
    const wait = rateLimitWait(failures, failure.retryAfterMs);
    return wait + Math.round(random() * wait * RATE_LIMIT_JITTER);
  }
  const base = failure.code === "UPSTREAM_FAILED" ? ERROR_BACKOFF_MS : AUTH_BACKOFF_MS;
  return jittered(Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, failures - 1)), random);
}

function renewedLogin(snapshot: StoredLimitSnapshot, loginVersion: number): boolean {
  return snapshot.failures > 0 && snapshot.loginVersion !== loginVersion;
}

function retryBlocked(snapshot: StoredLimitSnapshot, now: number): boolean {
  return snapshot.retryAt !== null && snapshot.retryAt > now;
}

export function pollDue(snapshot: StoredLimitSnapshot | null, loginVersion: number, now: number): boolean {
  if (!snapshot) return true;
  if (retryBlocked(snapshot, now)) return false;
  return snapshot.nextAt <= now || renewedLogin(snapshot, loginVersion);
}

export function failureCount(failure: LimitFetchFailure, previous: StoredLimitSnapshot | null): number {
  if (failure.code === RATE_LIMITED && previous?.error !== RATE_LIMITED) return 1;
  return (previous?.failures ?? 0) + 1;
}

function claimConditions(
  mode: LimitRefreshMode,
  kind: string,
  loginVersion: number,
  now: number,
): Prisma.ProviderLimitSnapshotWhereInput[] {
  const at = new Date(now);
  const free = { OR: [{ leaseUntil: null }, { leaseUntil: { lt: at } }] };
  const open = { OR: [{ retryAt: null }, { retryAt: { lte: at } }] };
  const renewed = { failures: { gt: 0 }, loginVersion: { not: loginVersion } };
  if (mode.kind === "scheduled") return [free, open, { OR: [{ nextAt: { lte: at } }, renewed] }];
  if (mode.kind === "manual") {
    return [
      free,
      open,
      { OR: [{ checkedAt: null }, { checkedAt: { lte: new Date(now - manualRefreshGap(kind)) } }, renewed] },
    ];
  }
  const stale = mode.maxAgeMs > 0 ? [{ OR: [{ fetchedAt: null }, { fetchedAt: { lt: new Date(now - mode.maxAgeMs) } }] }] : [];
  return [free, open, ...stale, { OR: [{ failures: 0 }, { nextAt: { lte: at } }, renewed] }];
}

export async function readStoredSnapshot(providerId: string): Promise<StoredLimitSnapshot | null> {
  const row = await prisma.providerLimitSnapshot.findUnique({ where: { providerId } });
  return row ? storedOf(row) : null;
}

async function loginVersionOf(providerId: string): Promise<number> {
  const row = await prisma.providerLogin.findUnique({ where: { providerId }, select: { version: true } });
  return row?.version ?? -1;
}

async function claim(account: LimitPollAccount, mode: LimitRefreshMode, now: number): Promise<string | null> {
  try {
    await prisma.providerLimitSnapshot.createMany({
      data: [{ providerId: account.id, nextAt: new Date(now) }],
      skipDuplicates: true,
    });
  } catch (error) {
    if (isPrismaCode(error, "P2003")) return null;
    throw error;
  }
  const leaseToken = randomUUID();
  const claimed = await prisma.providerLimitSnapshot.updateMany({
    where: { providerId: account.id, AND: claimConditions(mode, account.kind, account.loginVersion, now) },
    data: { leaseUntil: new Date(now + LIMIT_LEASE_MS), leaseToken },
  });
  return claimed.count ? leaseToken : null;
}

async function settledSnapshot(providerId: string, version: number, deadline: number): Promise<StoredLimitSnapshot | null> {
  for (;;) {
    const row = await readStoredSnapshot(providerId);
    if (!row || row.version !== version || row.leaseUntil === null || Date.now() >= deadline) return row;
    await sleep(LEASE_POLL_MS);
  }
}

function withPreviousObservation(
  kind: string,
  limits: SubscriptionLimits,
  previous: StoredLimitSnapshot | null,
  now: number,
): SubscriptionLimits {
  const observed = previous?.limits?.observedAt;
  if (!observed) return limits;
  if (!limitsFromTraffic(kind)) return { ...limits, observedAt: observed };
  const carried = observedWindowsBefore(previous.limits?.windows ?? [], limits.windows, now);
  return { ...limits, windows: [...carried, ...limits.windows], observedAt: observed };
}

function successData(account: LimitPollAccount, limits: SubscriptionLimits, now: number, random: () => number) {
  const streaming = isStreamingActive(account.id, now);
  return {
    limits: json(limits),
    error: "",
    fetchedAt: new Date(now),
    checkedAt: new Date(now),
    failures: 0,
    retryAt: null,
    nextAt: new Date(nextPollAt(account.kind, limits, now, random, streaming)),
    loginVersion: account.loginVersion,
  };
}

function failureData(
  account: LimitPollAccount,
  failure: LimitFetchFailure,
  previous: StoredLimitSnapshot | null,
  now: number,
  random: () => number,
) {
  const failures = failureCount(failure, previous);
  const limited = failure.code === RATE_LIMITED;
  return {
    error: failure.code,
    checkedAt: new Date(now),
    failures,
    retryAt: limited ? new Date(now + rateLimitWait(failures, failure.retryAfterMs)) : null,
    nextAt: new Date(now + failureDelay(failure, failures, random)),
    loginVersion: account.loginVersion,
  };
}

async function clearAccountDeploymentsCooldown(providerId: string): Promise<void> {
  try {
    const routes = await prisma.deployment.findMany({ where: { providerId }, select: { id: true } });
    if (routes.length) {
      const { clearCooldowns } = await import("@/lib/gateway/routing/provider-health");
      await clearCooldowns(routes.map((r) => r.id));
    }
  } catch (err) {
    logger.warn("subscription.clear_cooldown_failed", { providerId, ...errorFields(err) });
  }
}

async function fetchHeld(
  account: LimitPollAccount,
  token: string,
  now: number,
  random: () => number,
): Promise<LimitRefreshResult> {
  const previous = await readStoredSnapshot(account.id);
  let limits: SubscriptionLimits | null = null;
  let failure: LimitFetchFailure | null = null;
  try {
    const fetched = await fetchSubscriptionLimits(account);
    limits = fetched ? withPreviousObservation(account.kind, fetched, previous, now) : null;
    if (!limits) failure = { code: "UPSTREAM_FAILED", retryAfterMs: null };
  } catch (error) {
    failure = limitFailure(error);
    logger.warn("subscription.limits_failed", {
      providerId: account.id,
      kind: account.kind,
      code: failure.code,
      ...(error instanceof LimitsFetchError ? {} : errorFields(error)),
    });
  }
  const data = limits
    ? successData(account, limits, now, random)
    : failureData(account, failure ?? { code: "UPSTREAM_FAILED", retryAfterMs: null }, previous, now, random);
  const written = await prisma.providerLimitSnapshot.updateMany({
    where: { providerId: account.id, leaseToken: token },
    data: { ...data, leaseUntil: null, leaseToken: "", version: { increment: 1 } },
  });
  if (limits) {
    rememberLimits(account.id, limits);
    if (!hasExhaustedQuota(limits, now)) void clearAccountDeploymentsCooldown(account.id);
  }
  if (written.count) notifyLive("limits");
  return { status: "fetched", limits, failure, snapshot: await readStoredSnapshot(account.id) };
}

export async function refreshLimits(
  account: LimitPollAccount,
  mode: LimitRefreshMode,
  options: { now?: number; random?: () => number } = {},
): Promise<LimitRefreshResult> {
  const now = options.now ?? Date.now();
  const token = await claim(account, mode, now);
  if (token) return fetchHeld(account, token, now, options.random ?? Math.random);
  const snapshot = await readStoredSnapshot(account.id);
  if (!snapshot) return { status: "gone", limits: null, failure: null, snapshot: null };
  const busy = snapshot.leaseUntil !== null && snapshot.leaseUntil >= now;
  if (!busy) return { status: "skipped", limits: snapshot.limits, failure: null, snapshot };
  if (mode.kind === "scheduled") return { status: "busy", limits: snapshot.limits, failure: null, snapshot };
  const settled = await settledSnapshot(account.id, snapshot.version, Date.now() + LEASE_WAIT_MS);
  return { status: "busy", limits: settled?.limits ?? null, failure: null, snapshot: settled };
}

function recentLimits(providerId: string, stored: StoredLimitSnapshot | null): SubscriptionLimits | null {
  if (!stored?.limits || stored.fetchedAt === null) return null;
  rememberLimits(providerId, stored.limits);
  return limitsSnapshot(providerId);
}

export async function freshLimits(provider: LimitAccount, maxAgeMs: number): Promise<SubscriptionLimits | null> {
  const now = Date.now();
  const recent = recentLimits(provider.id, await readStoredSnapshot(provider.id));
  if (recent && now - limitsUpdatedAt(recent) < maxAgeMs) return recent;
  const account = { ...provider, enabled: true, loginVersion: await loginVersionOf(provider.id) };
  const result = await refreshLimits(account, { kind: "fresh", maxAgeMs }, { now });
  if (result.failure) throw new LimitsFetchError(result.failure.code, result.failure.retryAfterMs);
  if (result.limits) rememberLimits(provider.id, result.limits);
  return result.limits;
}

export async function pollAccounts(): Promise<(LimitPollAccount & { snapshot: StoredLimitSnapshot | null })[]> {
  const rows = await prisma.providerConnection.findMany({
    where: { ...ACTIVE_ACCOUNT, enabled: true },
    select: {
      id: true,
      kind: true,
      apiKey: true,
      enabled: true,
      login: { select: { version: true } },
      limitSnapshot: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    apiKey: row.apiKey,
    enabled: row.enabled,
    loginVersion: row.login?.version ?? -1,
    snapshot: row.limitSnapshot ? storedOf(row.limitSnapshot) : null,
  }));
}

export function snapshotView(
  kind: string,
  polled: boolean,
  stored: StoredLimitSnapshot,
  state: ResetState | null,
  now: number,
): LimitSnapshot {
  const limits = stored.limits
    ? { ...stored.limits, resetCredits: resetCreditsView(kind, stored.limits, stored.resets, state, now) }
    : null;
  return {
    id: stored.providerId,
    limits,
    error: stored.error,
    version: stored.version,
    checkedAt: iso(stored.checkedAt),
    nextAt: polled ? iso(stored.nextAt) : null,
    retryAt: stored.retryAt !== null && stored.retryAt > now ? iso(stored.retryAt) : null,
  };
}

async function resetStates(providerIds: string[]): Promise<Map<string, ResetState>> {
  if (!providerIds.length) return new Map();
  const rows = await prisma.setting.findMany({ where: { key: { in: providerIds.map(resetStateKey) } } });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return new Map(providerIds.map((id) => [id, parseResetState(byKey.get(resetStateKey(id)), id)]));
}

export async function readLimitSnapshots(providerIds?: string[], now = Date.now()): Promise<LimitSnapshot[]> {
  if (providerIds && !providerIds.length) return [];
  const rows = await prisma.providerLimitSnapshot.findMany({
    where: {
      checkedAt: { not: null },
      provider: ACTIVE_ACCOUNT,
      ...(providerIds ? { providerId: { in: providerIds } } : {}),
    },
    include: { provider: { select: { kind: true, enabled: true } } },
  });
  const states = await resetStates(rows.filter((row) => isResetKind(row.provider.kind)).map((row) => row.providerId));
  return rows.map((row) =>
    snapshotView(row.provider.kind, row.provider.enabled, storedOf(row), states.get(row.providerId) ?? null, now),
  );
}

export async function readLimitSnapshot(providerId: string, now = Date.now()): Promise<LimitSnapshot | null> {
  const [stored, provider] = await Promise.all([
    readStoredSnapshot(providerId),
    prisma.providerConnection.findUnique({ where: { id: providerId }, select: { kind: true, enabled: true } }),
  ]);
  if (!stored || !provider || stored.checkedAt === null) return null;
  const state = isResetKind(provider.kind)
    ? parseResetState(
        (await prisma.setting.findUnique({ where: { key: resetStateKey(providerId) } }))?.value,
        providerId,
      )
    : null;
  return snapshotView(provider.kind, provider.enabled, stored, state, now);
}

export async function limitVersions(): Promise<Map<string, number>> {
  const rows = await prisma.providerLimitSnapshot.findMany({
    where: { checkedAt: { not: null }, provider: ACTIVE_ACCOUNT },
    select: { providerId: true, version: true },
  });
  return new Map(rows.map((row) => [row.providerId, row.version]));
}

export async function storeResetView(providerId: string, view: ResetCredits | null, at: number): Promise<void> {
  const written = await prisma.providerLimitSnapshot.updateMany({
    where: { providerId },
    data: { resets: view ? json(view) : Prisma.DbNull, resetsAt: new Date(at), version: { increment: 1 } },
  });
  if (written.count) notifyLive("limits");
}

export async function expireResetView(providerId: string): Promise<void> {
  await prisma.providerLimitSnapshot.updateMany({ where: { providerId }, data: { resetsAt: null } });
}

export async function touchLimitSnapshot(providerId: string): Promise<void> {
  const written = await prisma.providerLimitSnapshot.updateMany({
    where: { providerId },
    data: { version: { increment: 1 } },
  });
  if (written.count) notifyLive("limits");
}

async function hydrate(providerIds: string[], now: number): Promise<void> {
  try {
    const rows = await prisma.providerLimitSnapshot.findMany({
      where: { providerId: { in: providerIds } },
      select: { providerId: true, limits: true, fetchedAt: true },
    });
    for (const row of rows) {
      const limits = row.fetchedAt ? limitsOf(row.limits) : null;
      if (limits) rememberLimits(row.providerId, limits);
      else if (!row.fetchedAt) dropCachedLimits(row.providerId);
    }
  } catch (err) {
    logger.warn("subscription.limits_hydrate_failed", errorFields(err));
  } finally {
    for (const id of providerIds) {
      hydratedAt.set(id, now);
      hydrating.delete(id);
    }
  }
}

export async function hydrateLimits(providerIds: string[], now = Date.now()): Promise<void> {
  const waits: Promise<void>[] = [];
  const stale: string[] = [];
  for (const id of new Set(providerIds)) {
    const pending = hydrating.get(id);
    if (pending) waits.push(pending);
    else if (now - (hydratedAt.get(id) ?? -Infinity) >= HYDRATE_MS) stale.push(id);
  }
  if (stale.length) {
    const read = hydrate(stale, now);
    for (const id of stale) hydrating.set(id, read);
    waits.push(read);
  }
  await Promise.all(waits);
}

export function nudgeLimits(providerId: string, kind: string, now = Date.now()): void {
  if (now - (observedAt.get(providerId) ?? -Infinity) < NUDGE_GAP_MS) return;
  if (now - (nudgedAt.get(providerId) ?? -Infinity) < NUDGE_GAP_MS) return;
  nudgedAt.set(providerId, now);
  void Promise.resolve()
    .then(() =>
      prisma.providerLimitSnapshot.updateMany({
        where: {
          providerId,
          nextAt: { gt: new Date(now) },
          checkedAt: { lte: new Date(now - manualRefreshGap(kind)) },
          OR: [{ retryAt: null }, { retryAt: { lte: new Date(now) } }],
        },
        data: { nextAt: new Date(now) },
      }),
    )
    .catch((err: unknown) => {
      logger.warn("subscription.limits_nudge_failed", { providerId, ...errorFields(err) });
    });
}

export async function usageBlockedUntil(providerId: string, now: number): Promise<number | null> {
  const stored = await readStoredSnapshot(providerId);
  return stored?.retryAt != null && stored.retryAt > now ? stored.retryAt : null;
}

export async function blockUsageReads(
  providerId: string,
  retryAfterMs: number | null,
  now: number,
  random: () => number = Math.random,
): Promise<number | null> {
  const stored = await readStoredSnapshot(providerId);
  if (!stored) return null;
  const failure: LimitFetchFailure = { code: RATE_LIMITED, retryAfterMs };
  const failures = failureCount(failure, stored);
  const retryAt = Math.max(now + rateLimitWait(failures, retryAfterMs), stored.retryAt ?? 0);
  const nextAt = Math.max(stored.nextAt, retryAt, now + failureDelay(failure, failures, random));
  const written = await prisma.providerLimitSnapshot.updateMany({
    where: { providerId },
    data: {
      error: RATE_LIMITED,
      failures,
      retryAt: new Date(retryAt),
      nextAt: new Date(nextAt),
      version: { increment: 1 },
    },
  });
  if (written.count) notifyLive("limits");
  return retryAt;
}

function observedBase(now: number): SubscriptionLimits {
  return { plan: "", windows: [], credits: null, resetCredits: null, extraUsage: null, fetchedAt: new Date(now).toISOString() };
}

function trafficPollAt(stored: StoredLimitSnapshot, limits: SubscriptionLimits, now: number): number | null {
  if (stored.fetchedAt === null || stored.failures > 0) return null;
  const recovery = accountRecoveryAt(limits, now);
  if (recovery !== null && recovery + RESET_GRACE_MS < now + CLAUDE_POLL_MS) {
    const afterReset = recovery + RESET_GRACE_MS;
    const target = Math.max(now + MIN_POLL_GAP_MS, afterReset);
    return target !== stored.nextAt ? target : null;
  }
  const at = Math.min(stored.fetchedAt + CLAUDE_TRAFFIC_POLL_MS, now + CLAUDE_POLL_MS);
  return at > stored.nextAt ? at : null;
}

export async function storeObservedLimits(providerId: string, windows: LimitWindow[], now: number): Promise<boolean> {
  for (let attempt = 0; attempt < OBSERVED_WRITE_ATTEMPTS; attempt++) {
    const stored = await readStoredSnapshot(providerId);
    if (!stored) return false;
    const base = stored.limits ?? observedBase(now);
    const merged = withObservedWindows(base, windows, now);
    const changed = !stored.limits || observedChanged(base.windows, merged.windows.filter(isObservedWindow));
    if (!changed && now - observedTime(base) < OBSERVED_WRITE_GAP_MS) return false;
    const pushTo = trafficPollAt(stored, merged, now);
    const written = await prisma.providerLimitSnapshot.updateMany({
      where: { providerId, version: stored.version },
      data: {
        limits: json(merged),
        ...(pushTo !== null ? { nextAt: new Date(pushTo) } : {}),
        version: { increment: 1 },
      },
    });
    if (!written.count) continue;
    if (stored.fetchedAt !== null) rememberLimits(providerId, merged);
    notifyLive("limits");
    return true;
  }
  return false;
}

function observedWriteDue(last: { at: number; windows: LimitWindow[] } | undefined, windows: LimitWindow[], now: number) {
  if (!last || observedFlipped(last.windows, windows)) return true;
  if (now - last.at < OBSERVED_WRITE_GAP_MS) return false;
  return observedChanged(last.windows, windows) || now - last.at >= OBSERVED_REFRESH_MS;
}

function observeFailed(providerId: string, err: unknown): false {
  logger.warn("subscription.limits_observe_failed", { providerId, ...errorFields(err) });
  return false;
}

function queueObservedWrite(providerId: string, windows: LimitWindow[], now: number): Promise<boolean> {
  const chain: Promise<boolean> = (observedChains.get(providerId) ?? Promise.resolve(false))
    .then(() => storeObservedLimits(providerId, windows, now))
    .catch((err: unknown) => observeFailed(providerId, err))
    .finally(() => {
      if (observedChains.get(providerId) === chain) observedChains.delete(providerId);
    });
  observedChains.set(providerId, chain);
  return chain;
}

export function observeClaudeLimits(providerId: string, headers: Headers, now = Date.now()): Promise<boolean> {
  try {
    return observeLimitWindows(providerId, claudeHeaderWindows(headers), now);
  } catch (err) {
    return Promise.resolve(observeFailed(providerId, err));
  }
}

export function observeLimitWindows(providerId: string, windows: LimitWindow[], now = Date.now()): Promise<boolean> {
  try {
    if (!windows.length) return Promise.resolve(false);
    observedAt.set(providerId, now);
    const cached = limitsSnapshot(providerId);
    if (cached) rememberLimits(providerId, withObservedWindows(cached, windows, now));
    if (!observedWriteDue(observedWrites.get(providerId), windows, now)) return Promise.resolve(false);
    observedWrites.set(providerId, { at: now, windows });
    return queueObservedWrite(providerId, windows, now);
  } catch (err) {
    return Promise.resolve(observeFailed(providerId, err));
  }
}
