import "server-only";
import { randomUUID } from "node:crypto";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { GateError } from "@/lib/gateway/errors";
import { autoResetPolicies } from "@/lib/gateway/routing/account-routing";
import { isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { clearCooldowns } from "@/lib/gateway/routing/provider-health";
import { quotaExhausted } from "@/lib/gateway/routing/quota";
import { providerAuth } from "@/lib/gateway/upstreams/credentials";
import {
  claimClaudeReset,
  claudeResetCredits,
  codexResetCredits,
  consumeCodexCredit,
  fetchClaudeOrg,
  fetchClaudeResets,
  fetchCodexCredits,
  redeemSucceeded,
  selectGrant,
  soonestCredit,
} from "@/lib/gateway/upstreams/reset-credits";
import { forgetLimits, limitsSnapshot, subscriptionLimits } from "@/lib/gateway/upstreams/subscription-limits";
import { acquireLease, releaseLease } from "@/lib/jobs/lease";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { parseJsonOrNull } from "@/lib/utils/json";
import { RESET_KINDS, resetStateSchema } from "@/schemas/resets";
import type { LimitWindow, SubscriptionLimits, UpstreamAuth } from "@/types/providers";
import type {
  AutoResetOutcome,
  AutoResetPolicy,
  AutoSkipReason,
  AutoUsage,
  ClaudeResetBlock,
  CodexCreditList,
  PendingClaim,
  PendingResetView,
  RedeemOutcome,
  ResetCredits,
  ResetKind,
  ResetProvider,
  ResetResult,
  ResetState,
  ResetTrigger,
  StatusRead,
} from "@/types/resets";

export const RETRY_WINDOW_MS = 10 * 60_000;
export const AUTO_GUARD_MS = 15 * 60_000;
const LEASE_MS = 90_000;
const CLAUDE_VIEW_AGE_MS = 60 * 60_000;
const CLAUDE_REFRESH_AGE_MS = 5 * 60_000;
const CLAUDE_DECISION_AGE_MS = 10 * 60_000;
const CLAUDE_REDEEM_AGE_MS = 2 * 60_000;
const CODEX_VIEW_AGE_MS = 15 * 60_000;
const CODEX_REFRESH_AGE_MS = 2 * 60_000;
const ORG_TTL_MS = 60 * 60_000;
const READ_BACKOFF_MS = 5 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 60 * 60_000;
const USAGE_MAX_AGE_MS = 5 * 60_000;
const SETTLE_DELAY_MS = 20_000;
const HOOK_THROTTLE_MS = 60_000;
const FULL_PERCENT = 100;
const WORKER_ACTOR = "worker";
const STATE_PREFIX = "provider_reset:";
const LOCK_PREFIX = "provider_reset_lock:";
const AUTO_LOCK_PREFIX = "provider_reset_auto_lock:";
const POOL_GUARD_PREFIX = "provider_reset_pool:";

type Cached<T> = { at: number; value: T | null };

const claudeStatus = new Map<string, Cached<ClaudeResetBlock>>();
const codexStatus = new Map<string, Cached<CodexCreditList>>();
const readBackoff = new Map<string, number>();
const orgs = new Map<string, { at: number; uuid: string }>();
const hookRuns = new Map<string, Promise<AutoResetOutcome>>();
const hookAt = new Map<string, number>();

function skipped(reason: AutoSkipReason): AutoResetOutcome {
  return { status: "skipped", reason };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function liveWindow(window: LimitWindow, now: number): LimitWindow {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return Number.isFinite(resetsAt) && resetsAt <= now ? { ...window, usedPercent: 0, limitReached: false } : window;
}

function planWindows(limits: SubscriptionLimits, now: number): LimitWindow[] {
  return limits.windows.filter((window) => !window.scope).map((window) => liveWindow(window, now));
}

export function accountUsage(limits: SubscriptionLimits | null, now: number): number | null {
  if (!limits) return null;
  const windows = planWindows(limits, now);
  if (!windows.length) return null;
  if (windows.some((window) => window.limitReached)) return FULL_PERCENT;
  return Math.max(...windows.map((window) => window.usedPercent));
}

export function accountRecovery(limits: SubscriptionLimits | null, percent: number, now: number): number {
  if (!limits) return Infinity;
  const tight = planWindows(limits, now).filter((window) => window.limitReached || window.usedPercent >= percent);
  if (!tight.length) return 0;
  return Math.max(...tight.map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : Infinity)));
}

export function dueForReset(policy: AutoResetPolicy, usages: AutoUsage[], focusId: string | null): string[] {
  const over = (item: AutoUsage) => item.usage !== null && item.usage >= policy.percent;
  const longestWait = (a: AutoUsage, b: AutoUsage) => (b.recovery === a.recovery ? 0 : b.recovery > a.recovery ? 1 : -1);
  if (policy.scope === "account") {
    return usages
      .filter((item) => (focusId === null || item.id === focusId) && over(item))
      .sort(longestWait)
      .map((item) => item.id);
  }
  if (!usages.length || !usages.every(over)) return [];
  return [...usages].sort(longestWait).map((item) => item.id);
}

export function autoGuardOpen(state: ResetState, now: number): boolean {
  return state.pending === null && now - state.lastAutoAt >= AUTO_GUARD_MS;
}

function stateKey(providerId: string): string {
  return `${STATE_PREFIX}${providerId}`;
}

function lockKey(providerId: string): string {
  return `${LOCK_PREFIX}${providerId}`;
}

function parseState(value: string | undefined, providerId: string): ResetState {
  const parsed = resetStateSchema.safeParse(value ? parseJsonOrNull(value) : {});
  if (parsed.success) return parsed.data;
  logger.error("provider.reset_state_invalid", { providerId });
  return { pending: null, lastAutoAt: 0 };
}

export async function loadResetState(providerId: string): Promise<ResetState> {
  const row = await prisma.setting.findUnique({ where: { key: stateKey(providerId) } });
  return parseState(row?.value, providerId);
}

async function saveResetState(providerId: string, state: ResetState): Promise<void> {
  const key = stateKey(providerId);
  if (!state.pending && !state.lastAutoAt) {
    await prisma.setting.deleteMany({ where: { key } });
    return;
  }
  const value = JSON.stringify(state);
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function withLease<T>(key: string, work: () => Promise<T>): Promise<{ value: T } | null> {
  const token = await acquireLease(key, LEASE_MS);
  if (!token) return null;
  try {
    return { value: await work() };
  } finally {
    await releaseLease(key, token).catch((err: unknown) => {
      logger.warn("provider.reset_lease_release_failed", { key, ...errorFields(err) });
    });
  }
}

async function authFor(provider: ResetProvider): Promise<UpstreamAuth> {
  try {
    return await providerAuth(provider);
  } catch (error) {
    if (error instanceof GateError) throw new Error("SIGN_IN_EXPIRED", { cause: error });
    throw error;
  }
}

async function cachedRead<T>(
  cache: Map<string, Cached<T>>,
  provider: ResetProvider,
  maxAgeMs: number,
  now: number,
  read: (auth: UpstreamAuth) => Promise<StatusRead<T>>,
): Promise<Cached<T> | null> {
  const hit = cache.get(provider.id) ?? null;
  if (hit && now - hit.at <= maxAgeMs) return hit;
  if ((readBackoff.get(provider.id) ?? 0) > now) return hit;
  let auth: UpstreamAuth;
  try {
    auth = await providerAuth(provider);
  } catch (err) {
    readBackoff.set(provider.id, now + READ_BACKOFF_MS);
    logger.warn("provider.reset_status_failed", { providerId: provider.id, kind: provider.kind, ...errorFields(err) });
    return hit;
  }
  const res = await read(auth);
  if (res.status >= 200 && res.status < 300) {
    const entry = { at: now, value: res.value };
    cache.set(provider.id, entry);
    readBackoff.delete(provider.id);
    if (!res.value) logger.warn("provider.reset_status_invalid", { providerId: provider.id, kind: provider.kind });
    return entry;
  }
  const wait = res.status === 429 ? (res.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS) : READ_BACKOFF_MS;
  readBackoff.set(provider.id, now + wait);
  logger.warn("provider.reset_status_failed", { providerId: provider.id, kind: provider.kind, status: res.status });
  return hit;
}

function readClaude(provider: ResetProvider, maxAgeMs: number, now: number) {
  return cachedRead(claudeStatus, provider, maxAgeMs, now, fetchClaudeResets);
}

function readCodex(provider: ResetProvider, maxAgeMs: number, now: number) {
  return cachedRead(codexStatus, provider, maxAgeMs, now, fetchCodexCredits);
}

function forgetResetStatus(providerId: string): void {
  claudeStatus.delete(providerId);
  codexStatus.delete(providerId);
}

async function orgOf(provider: ResetProvider, auth: UpstreamAuth, now: number): Promise<string> {
  const cached = orgs.get(provider.id);
  if (cached && now - cached.at < ORG_TTL_MS) return cached.uuid;
  const uuid = await fetchClaudeOrg(auth);
  if (uuid) orgs.set(provider.id, { at: now, uuid });
  return uuid;
}

async function auditRedeem(
  provider: ResetProvider,
  claim: PendingClaim,
  actor: string,
  trigger: ResetTrigger,
  result: ResetResult | "expired",
  windowsReset: number,
): Promise<void> {
  await writeAudit({
    actor,
    action: "provider.reset_redeem",
    objectType: "provider",
    objectId: provider.id,
    after: {
      kind: claim.kind,
      trigger,
      result,
      attempt: claim.attempts,
      requestId: claim.requestId,
      ...(claim.creditId ? { creditId: claim.creditId } : {}),
      ...(claim.grantId ? { grantId: claim.grantId } : {}),
      windowsReset,
    },
  }).catch((err: unknown) => {
    logger.error("provider.reset_audit_failed", { providerId: provider.id, result, ...errorFields(err) });
  });
}

async function freshStatusAt(provider: ResetProvider, now: number): Promise<number> {
  if (provider.kind === "codex") {
    const limits = await subscriptionLimits(provider, { force: true }).catch(() => null);
    return limits ? Date.parse(limits.fetchedAt) : 0;
  }
  return (await readClaude(provider, 0, now))?.at ?? 0;
}

async function settleStaleLocked(provider: ResetProvider, actor: string, now: number): Promise<boolean> {
  const state = await loadResetState(provider.id);
  const pending = state.pending;
  if (!pending) return true;
  const retryUntil = pending.startedAt + RETRY_WINDOW_MS;
  if (now <= retryUntil) return false;
  if ((await freshStatusAt(provider, now)) <= retryUntil) return false;
  await saveResetState(provider.id, { ...state, pending: null });
  await auditRedeem(provider, pending, actor, pending.trigger, "expired", 0);
  return true;
}

async function newClaim(
  provider: ResetProvider & { kind: ResetKind },
  auth: UpstreamAuth,
  actor: string,
  trigger: ResetTrigger,
  statusAgeMs: number,
  now: number,
): Promise<PendingClaim> {
  const base = { requestId: randomUUID(), startedAt: now, attempts: 0, trigger, actor };
  if (provider.kind === "codex") {
    const limits = await subscriptionLimits(provider, { force: true });
    if (!((limits?.resetCredits?.applicable ?? 0) > 0)) throw new Error("RESET_NOT_AVAILABLE");
    const credit = soonestCredit((await readCodex(provider, CODEX_REFRESH_AGE_MS, now))?.value ?? null, now);
    return { kind: "codex", ...base, ...(credit ? { creditId: credit.id } : {}) };
  }
  const block = (await readClaude(provider, statusAgeMs, now))?.value ?? null;
  if (block?.cooldownUntil && Date.parse(block.cooldownUntil) > now) throw new Error("RESET_COOLDOWN");
  const grant = selectGrant(block, now);
  if (!grant) throw new Error("RESET_NOT_AVAILABLE");
  const orgUuid = await orgOf(provider, auth, now);
  if (!orgUuid) throw new Error("UPSTREAM_FAILED");
  return { kind: "claude", ...base, grantId: grant.id, orgUuid };
}

function sendClaim(auth: UpstreamAuth, claim: PendingClaim): Promise<RedeemOutcome> {
  if (claim.kind === "codex") {
    return consumeCodexCredit(auth, { redeemRequestId: claim.requestId, creditId: claim.creditId });
  }
  return claimClaudeReset(auth, {
    orgUuid: claim.orgUuid ?? "",
    grantId: claim.grantId ?? "",
    requestId: claim.requestId,
  });
}

function scheduleRecheck(provider: ResetProvider, deployments: string[]): void {
  const timer = setTimeout(() => {
    forgetLimits(provider.id);
    void subscriptionLimits(provider)
      .then(() => clearCooldowns(deployments))
      .catch((err: unknown) => {
        logger.warn("provider.reset_refresh_failed", { providerId: provider.id, ...errorFields(err) });
      });
  }, SETTLE_DELAY_MS);
  timer.unref?.();
}

async function afterReset(provider: ResetProvider): Promise<void> {
  forgetResetStatus(provider.id);
  forgetLimits(provider.id);
  const deployments = (
    await prisma.deployment.findMany({ where: { providerId: provider.id }, select: { id: true } })
  ).map((row) => row.id);
  await clearCooldowns(deployments);
  const limits = await subscriptionLimits(provider).catch((err: unknown) => {
    logger.warn("provider.reset_refresh_failed", { providerId: provider.id, ...errorFields(err) });
    return null;
  });
  if (!limits || quotaExhausted(limits, "", Date.now())) scheduleRecheck(provider, deployments);
}

async function redeemLocked(
  provider: ResetProvider & { kind: ResetKind },
  actor: string,
  trigger: ResetTrigger,
  statusAgeMs: number,
  now: number,
): Promise<RedeemOutcome> {
  let state = await loadResetState(provider.id);
  if (state.pending && trigger === "auto") throw new Error("RESET_PENDING");
  if (state.pending && now > state.pending.startedAt + RETRY_WINDOW_MS) {
    if (!(await settleStaleLocked(provider, actor, now))) throw new Error("RESET_PENDING");
    state = await loadResetState(provider.id);
  }
  const auth = await authFor(provider);
  const pending = state.pending ?? (await newClaim(provider, auth, actor, trigger, statusAgeMs, now));
  const claim: PendingClaim = { ...pending, attempts: pending.attempts + 1 };
  const lastAutoAt = trigger === "auto" ? now : state.lastAutoAt;
  await saveResetState(provider.id, { pending: claim, lastAutoAt });
  const outcome = await sendClaim(auth, claim);
  if (outcome.result !== "unknown") await saveResetState(provider.id, { pending: null, lastAutoAt });
  await auditRedeem(provider, claim, actor, trigger, outcome.result, outcome.windowsReset);
  if (outcome.result === "unknown") {
    logger.warn("provider.reset_outcome_unknown", { providerId: provider.id, kind: provider.kind, attempt: claim.attempts });
  } else if (redeemSucceeded(outcome.result)) {
    await afterReset(provider);
  } else {
    forgetResetStatus(provider.id);
  }
  return outcome;
}

export async function redeemReset(
  provider: ResetProvider,
  options: { actor: string; trigger: ResetTrigger; now?: number; statusAgeMs?: number },
): Promise<RedeemOutcome> {
  const kind = provider.kind;
  if (!isResetKind(kind)) throw new Error("RESET_UNSUPPORTED");
  const now = options.now ?? Date.now();
  const leased = await withLease(lockKey(provider.id), () =>
    redeemLocked(
      { ...provider, kind },
      options.actor,
      options.trigger,
      options.statusAgeMs ?? CLAUDE_REDEEM_AGE_MS,
      now,
    ),
  );
  if (!leased) throw new Error("RESET_BUSY");
  return leased.value;
}

function pendingView(pending: PendingClaim, now: number): PendingResetView {
  const retryUntil = pending.startedAt + RETRY_WINDOW_MS;
  return { startedAt: iso(pending.startedAt), retryUntil: iso(retryUntil), retryable: now <= retryUntil };
}

async function resetView(
  provider: ResetProvider & { kind: ResetKind },
  limits: SubscriptionLimits,
  refresh: boolean,
  now: number,
): Promise<ResetCredits | null> {
  let state = await loadResetState(provider.id);
  if (state.pending && now > state.pending.startedAt + RETRY_WINDOW_MS) {
    const settled = await withLease(lockKey(provider.id), () => settleStaleLocked(provider, WORKER_ACTOR, now));
    if (settled?.value) state = await loadResetState(provider.id);
  }
  let credits: ResetCredits | null;
  let checkedAt: number | null;
  if (provider.kind === "codex") {
    const list = await readCodex(provider, refresh ? CODEX_REFRESH_AGE_MS : CODEX_VIEW_AGE_MS, now);
    credits = codexResetCredits(limits.resetCredits, list?.value ?? null, now);
    checkedAt = Date.parse(limits.fetchedAt);
  } else {
    const status = await readClaude(provider, refresh ? CLAUDE_REFRESH_AGE_MS : CLAUDE_VIEW_AGE_MS, now);
    credits = status?.value ? claudeResetCredits(status.value, now) : null;
    checkedAt = status?.at ?? null;
  }
  if (!credits && !state.pending) return null;
  const base = credits ?? { available: 0, applicable: 0 };
  const pending = state.pending ? pendingView(state.pending, now) : null;
  return {
    ...base,
    pending,
    checkedAt: checkedAt !== null && Number.isFinite(checkedAt) ? iso(checkedAt) : null,
    canRedeem: pending ? pending.retryable : base.applicable > 0,
  };
}

export async function withResetDetails(
  provider: ResetProvider,
  limits: SubscriptionLimits | null,
  options: { refresh?: boolean; now?: number } = {},
): Promise<SubscriptionLimits | null> {
  const kind = provider.kind;
  if (!limits || !isResetKind(kind)) return limits;
  try {
    const credits = await resetView({ ...provider, kind }, limits, options.refresh === true, options.now ?? Date.now());
    return credits ? { ...limits, resetCredits: credits } : limits;
  } catch (err) {
    logger.warn("provider.reset_view_failed", { providerId: provider.id, kind, ...errorFields(err) });
    return limits;
  }
}

async function usageLimits(provider: ResetProvider, now: number): Promise<SubscriptionLimits | null> {
  const cached = limitsSnapshot(provider.id);
  if (cached && now - Date.parse(cached.fetchedAt) < USAGE_MAX_AGE_MS) return cached;
  return subscriptionLimits(provider).catch((err: unknown) => {
    logger.warn("provider.reset_usage_failed", { providerId: provider.id, ...errorFields(err) });
    return cached;
  });
}

async function applicableNow(provider: ResetProvider & { kind: ResetKind }, now: number): Promise<boolean> {
  if (provider.kind === "codex") return ((await usageLimits(provider, now))?.resetCredits?.applicable ?? 0) > 0;
  return selectGrant((await readClaude(provider, CLAUDE_DECISION_AGE_MS, now))?.value ?? null, now) !== null;
}

async function poolGuardAt(kind: ResetKind): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: `${POOL_GUARD_PREFIX}${kind}` } });
  const at = Number(row?.value);
  return Number.isFinite(at) ? at : 0;
}

async function savePoolGuard(kind: ResetKind, now: number): Promise<void> {
  const key = `${POOL_GUARD_PREFIX}${kind}`;
  const value = String(now);
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function redeemDue(
  kind: ResetKind,
  policy: AutoResetPolicy,
  accounts: ResetProvider[],
  due: string[],
  now: number,
): Promise<AutoResetOutcome[]> {
  if (policy.scope === "pool" && now - (await poolGuardAt(kind)) < AUTO_GUARD_MS) return [skipped("guard")];
  const outcomes: AutoResetOutcome[] = [];
  let reason: AutoSkipReason = "not_applicable";
  for (const id of due) {
    const account = accounts.find((item) => item.id === id);
    if (!account) continue;
    const provider = { ...account, kind };
    const state = await loadResetState(id);
    if (!autoGuardOpen(state, now)) {
      reason = state.pending ? "pending" : "guard";
      continue;
    }
    if (!(await applicableNow(provider, now))) continue;
    if (policy.scope === "pool") await savePoolGuard(kind, now);
    try {
      const outcome = await redeemReset(provider, {
        actor: WORKER_ACTOR,
        trigger: "auto",
        now,
        statusAgeMs: CLAUDE_DECISION_AGE_MS,
      });
      outcomes.push({
        status: redeemSucceeded(outcome.result) ? "redeemed" : "attempted",
        providerId: id,
        result: outcome.result,
      });
    } catch (err) {
      logger.warn("provider.reset_auto_failed", { providerId: id, kind, ...errorFields(err) });
      reason = "error";
    }
    if (policy.scope === "pool") break;
  }
  return outcomes.length ? outcomes : [skipped(reason)];
}

async function evaluateKind(
  kind: ResetKind,
  policy: AutoResetPolicy,
  focusId: string | null,
  now: number,
): Promise<AutoResetOutcome[]> {
  const accounts = await prisma.providerConnection.findMany({
    where: { kind, enabled: true, login: { is: { status: "active" } } },
    select: { id: true, kind: true, apiKey: true },
  });
  if (!accounts.length || (focusId !== null && !accounts.some((account) => account.id === focusId))) {
    return [skipped("no_accounts")];
  }
  const usages = await Promise.all(
    accounts.map(async (account): Promise<AutoUsage> => {
      const limits = await usageLimits(account, now);
      return { id: account.id, usage: accountUsage(limits, now), recovery: accountRecovery(limits, policy.percent, now) };
    }),
  );
  const due = dueForReset(policy, usages, focusId);
  if (!due.length) return [skipped(policy.scope === "pool" ? "pool_has_room" : "below_threshold")];
  const leased = await withLease(`${AUTO_LOCK_PREFIX}${kind}`, () => redeemDue(kind, policy, accounts, due, now));
  return leased ? leased.value : [skipped("busy")];
}

async function autoRedeemFor(providerId: string, now: number): Promise<AutoResetOutcome> {
  const provider = await prisma.providerConnection.findUnique({
    where: { id: providerId },
    select: { id: true, kind: true, apiKey: true },
  });
  if (!provider || !isResetKind(provider.kind)) return skipped("unsupported");
  const policy = (await autoResetPolicies(now))[provider.kind];
  if (!policy?.enabled) return skipped("off");
  await subscriptionLimits(provider, { force: true }).catch((err: unknown) => {
    logger.warn("provider.reset_usage_failed", { providerId, ...errorFields(err) });
  });
  const outcomes = await evaluateKind(provider.kind, policy, providerId, now);
  return outcomes.find((item) => "providerId" in item && item.providerId === providerId) ?? outcomes[0] ?? skipped("not_applicable");
}

export function autoRedeemIfDue(providerId: string): Promise<AutoResetOutcome> {
  const running = hookRuns.get(providerId);
  if (running) return running;
  const now = Date.now();
  if (now - (hookAt.get(providerId) ?? 0) < HOOK_THROTTLE_MS) return Promise.resolve(skipped("guard"));
  hookAt.set(providerId, now);
  const run = autoRedeemFor(providerId, now)
    .catch((err: unknown) => {
      logger.warn("provider.reset_auto_failed", { providerId, ...errorFields(err) });
      return skipped("error");
    })
    .finally(() => hookRuns.delete(providerId));
  hookRuns.set(providerId, run);
  return run;
}

async function settleStalePending(now: number): Promise<void> {
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: STATE_PREFIX } } });
  for (const row of rows) {
    const providerId = row.key.slice(STATE_PREFIX.length);
    const provider = await prisma.providerConnection.findUnique({
      where: { id: providerId },
      select: { id: true, kind: true, apiKey: true },
    });
    if (!provider) {
      await prisma.setting.deleteMany({ where: { key: row.key } });
      continue;
    }
    const state = parseState(row.value, providerId);
    if (state.pending && now > state.pending.startedAt + RETRY_WINDOW_MS) {
      await withLease(lockKey(providerId), () => settleStaleLocked(provider, WORKER_ACTOR, now));
    }
  }
}

export async function runAutoResets(now = Date.now()): Promise<number> {
  await settleStalePending(now);
  const policies = await autoResetPolicies(now);
  let redeemed = 0;
  for (const kind of RESET_KINDS) {
    const policy = policies[kind];
    if (!policy?.enabled) continue;
    const outcomes = await evaluateKind(kind, policy, null, now);
    redeemed += outcomes.filter((item) => item.status === "redeemed").length;
  }
  return redeemed;
}
