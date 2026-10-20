import "server-only";
import prisma from "@/lib/db/prisma";
import { open, seal } from "@/lib/crypto";
import { antigravityHeaders } from "@/lib/gateway/upstreams/antigravity";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import { claudeIdentityHeaders } from "@/lib/gateway/upstreams/claude";
import { asRecord, asString, VERSION } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { refreshSession } from "@/lib/gateway/upstreams/subscription-sign-in";
import { logger } from "@/lib/logging/logger";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { ResolvedDeployment } from "@/types/routing";
import type { LoginRefreshMode, SignInKind, SignInSession, SignInTokens, UpstreamAuth } from "@/types/providers";

const REFRESH_SKEW_MS = 5 * 60_000;
const REFRESH_LEAD_MS: Record<SignInKind, number> = {
  claude: 4 * 3_600_000,
  codex: 96 * 3_600_000,
  antigravity: 30 * 60_000,
  grok_build: 30 * 60_000,
};
const MAX_REFRESH_LEAD_MS = Math.max(...Object.values(REFRESH_LEAD_MS));
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const LEASE_MS = 30_000;
const LEASE_WAIT_MS = 20_000;
const LEASE_POLL_MS = 250;
const RENEW_GAP_MS = 60_000;
const SCHEDULED_BATCH = 16;
const SCHEDULED_CONCURRENCY = 4;
const EXPIRING: LoginRefreshMode = { reason: "expiring" };
const SCHEDULED: LoginRefreshMode = { reason: "scheduled" };
const CODEX_ORIGINATOR = "llmhub";

const refreshing = new Map<string, Promise<SignInSession>>();
const renewedAt = new Map<string, number>();

type LoginRow = {
  providerId: string;
  account: string;
  plan: string;
  tokens: string;
  expiresAt: Date;
  status: string;
  version: number;
  refreshedAt: Date | null;
  retryAt: Date | null;
  failures: number;
};

type RefreshTiming = Pick<LoginRow, "expiresAt" | "refreshedAt" | "retryAt">;

function signInRequired(): GateError {
  return new GateError(503, "no_provider_key", "provider sign-in expired; sign in again on the Providers page");
}

export function sealTokens(tokens: SignInTokens): string {
  return seal(JSON.stringify(tokens));
}

export function openTokens(sealed: string, providerId: string): SignInTokens {
  const rec = asRecord(parseJsonOrNull(open(sealed)));
  if (!rec) logger.warn("provider_login.tokens_unreadable", { providerId });
  return {
    access: asString(rec?.access),
    refresh: asString(rec?.refresh),
    accountId: asString(rec?.accountId),
    residency: asString(rec?.residency),
  };
}

function sessionOf(row: LoginRow): SignInSession {
  return { tokens: openTokens(row.tokens, row.providerId), expiresAt: row.expiresAt.getTime(), account: row.account, plan: row.plan };
}

function fresh(session: SignInSession, now = Date.now()): boolean {
  return Boolean(session.tokens.access) && session.expiresAt - now > REFRESH_SKEW_MS;
}

function usable(session: SignInSession, now = Date.now()): boolean {
  return Boolean(session.tokens.access) && session.expiresAt > now;
}

export function refreshDueAt(kind: SignInKind, login: RefreshTiming): number {
  const expires = login.expiresAt.getTime();
  const lifetime = login.refreshedAt ? expires - login.refreshedAt.getTime() : Infinity;
  const lead = Math.min(REFRESH_LEAD_MS[kind], Math.max(REFRESH_SKEW_MS, lifetime / 2));
  return Math.max(expires - lead, login.retryAt?.getTime() ?? 0);
}

function needsRefresh(row: LoginRow, session: SignInSession, kind: SignInKind, mode: LoginRefreshMode, now: number): boolean {
  if (mode.reason === "rejected") return row.version === mode.version;
  if (mode.reason === "scheduled") return refreshDueAt(kind, row) <= now;
  if (fresh(session, now)) return false;
  return !(usable(session, now) && (row.retryAt?.getTime() ?? 0) > now);
}

function retryDelay(failures: number, retryAfterMs: number | null): number {
  const backoff = retryAfterMs ?? RETRY_BASE_MS * 2 ** Math.min(failures - 1, 10);
  return Math.min(Math.max(backoff, RETRY_BASE_MS), RETRY_MAX_MS);
}

export function signInHeaders(kind: SignInKind, tokens: SignInTokens): Record<string, string> {
  if (kind === "claude") return claudeIdentityHeaders();
  if (kind === "antigravity") return antigravityHeaders();
  if (kind !== "codex") return {};
  const headers: Record<string, string> = {
    "ChatGPT-Account-ID": tokens.accountId,
    originator: CODEX_ORIGINATOR,
    "User-Agent": `LLMHub/${VERSION}`,
  };
  if (tokens.residency) headers["x-openai-internal-codex-residency"] = tokens.residency;
  return headers;
}

export function loginData(session: SignInSession, now = Date.now()) {
  return {
    account: session.account,
    plan: session.plan,
    tokens: sealTokens(session.tokens),
    expiresAt: new Date(session.expiresAt),
    status: "active",
    leaseUntil: null,
    refreshedAt: new Date(now),
    retryAt: null,
    failures: 0,
  };
}

export async function clearRefreshBackoff(providerId: string): Promise<void> {
  await prisma.providerLogin.updateMany({
    where: { providerId, status: "active", OR: [{ retryAt: { not: null } }, { failures: { gt: 0 } }] },
    data: { retryAt: null, failures: 0 },
  });
}

async function loadLogin(providerId: string): Promise<LoginRow> {
  const row = await prisma.providerLogin.findUnique({ where: { providerId } });
  if (!row || row.status !== "active") throw signInRequired();
  return row;
}

async function latestUsable(providerId: string): Promise<SignInSession> {
  const session = sessionOf(await loadLogin(providerId));
  if (usable(session)) return session;
  throw signInRequired();
}

async function renew(row: LoginRow, current: SignInSession, kind: SignInKind, mode: LoginRefreshMode): Promise<SignInSession> {
  const outcome = await refreshSession(kind, current);
  const now = Date.now();
  const where = { providerId: row.providerId, version: row.version };
  if (outcome.ok) {
    const saved = await prisma.providerLogin.updateMany({
      where,
      data: { ...loginData(outcome.session, now), version: { increment: 1 } },
    });
    return saved.count === 1 ? outcome.session : latestUsable(row.providerId);
  }
  const failures = row.failures + 1;
  const keep = mode.reason !== "rejected" && usable(current, now);
  const dead = outcome.fatal && !keep;
  const saved = await prisma.providerLogin.updateMany({
    where,
    data: {
      leaseUntil: null,
      failures,
      retryAt: new Date(now + retryDelay(failures, outcome.retryAfterMs)),
      ...(dead ? { status: "expired" } : {}),
    },
  });
  logger.warn("provider.sign_in_refresh_failed", {
    provider: row.providerId,
    kind,
    reason: mode.reason,
    fatal: outcome.fatal,
    failures,
    expired: dead,
  });
  if (saved.count !== 1) return latestUsable(row.providerId);
  if (keep) return current;
  throw signInRequired();
}

async function refreshLogin(providerId: string, kind: SignInKind, mode: LoginRefreshMode): Promise<SignInSession> {
  const deadline = Date.now() + LEASE_WAIT_MS;
  let seenFailures: number | null = null;
  for (;;) {
    const row = await loadLogin(providerId);
    const session = sessionOf(row);
    const now = Date.now();
    if (!needsRefresh(row, session, kind, mode, now)) return session;
    if (seenFailures !== null && row.failures > seenFailures) {
      if (mode.reason !== "rejected" && usable(session, now)) return session;
      throw signInRequired();
    }
    seenFailures ??= row.failures;
    const claimed = await prisma.providerLogin.updateMany({
      where: {
        providerId,
        version: row.version,
        status: "active",
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date(now) } }],
      },
      data: { leaseUntil: new Date(now + LEASE_MS) },
    });
    if (claimed.count === 1) return renew(row, session, kind, mode);
    if (mode.reason === "scheduled" && usable(session, now)) return session;
    if (Date.now() > deadline) {
      if (usable(session)) return session;
      throw signInRequired();
    }
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
  }
}

function deduplicated(providerId: string, start: () => Promise<SignInSession>): Promise<SignInSession> {
  const pending = refreshing.get(providerId);
  if (pending) return pending;
  const started = start().finally(() => refreshing.delete(providerId));
  refreshing.set(providerId, started);
  return started;
}

export async function renewRejectedLogin(providerId: string, kind: SignInKind, now = Date.now()): Promise<boolean> {
  const pending = refreshing.get(providerId);
  if (pending) return pending.then(() => true, () => false);
  if (now - (renewedAt.get(providerId) ?? 0) < RENEW_GAP_MS) return true;
  renewedAt.set(providerId, now);
  return deduplicated(providerId, async () => {
    const row = await loadLogin(providerId);
    return refreshLogin(providerId, kind, { reason: "rejected", version: row.version });
  }).then(
    () => true,
    () => false,
  );
}

async function activeSession(providerId: string, kind: SignInKind): Promise<SignInSession> {
  const row = await loadLogin(providerId);
  const session = sessionOf(row);
  if (!needsRefresh(row, session, kind, EXPIRING, Date.now())) return session;
  const shared = await deduplicated(providerId, () => refreshLogin(providerId, kind, EXPIRING));
  return usable(shared) ? shared : refreshLogin(providerId, kind, EXPIRING);
}

async function refreshScheduled(providerId: string, kind: SignInKind, expiresAt: Date): Promise<boolean> {
  try {
    const session = await deduplicated(providerId, () => refreshLogin(providerId, kind, SCHEDULED));
    return session.expiresAt !== expiresAt.getTime();
  } catch {
    return false;
  }
}

export async function refreshDueLogins(now = Date.now()): Promise<number> {
  const rows = await prisma.providerLogin.findMany({
    where: { status: "active", expiresAt: { lte: new Date(now + MAX_REFRESH_LEAD_MS) } },
    select: { providerId: true, expiresAt: true, refreshedAt: true, retryAt: true, provider: { select: { kind: true } } },
    orderBy: { expiresAt: "asc" },
  });
  const due = rows
    .flatMap((row) => {
      const kind = row.provider.kind;
      return isSignInKind(kind) && refreshDueAt(kind, row) <= now ? [{ ...row, kind }] : [];
    })
    .slice(0, SCHEDULED_BATCH);
  let refreshed = 0;
  for (let i = 0; i < due.length; i += SCHEDULED_CONCURRENCY) {
    const batch = due.slice(i, i + SCHEDULED_CONCURRENCY);
    const results = await Promise.all(batch.map((row) => refreshScheduled(row.providerId, row.kind, row.expiresAt)));
    refreshed += results.filter(Boolean).length;
  }
  return refreshed;
}

export function sessionAuth(kind: SignInKind, session: SignInSession): UpstreamAuth {
  return {
    key: session.tokens.access,
    headers: signInHeaders(kind, session.tokens),
    ...(kind === "antigravity" ? { project: session.tokens.accountId } : {}),
  };
}

export async function providerAuth(provider: { id: string; kind: string; apiKey: string }): Promise<UpstreamAuth> {
  if (!isSignInKind(provider.kind)) return { key: open(provider.apiKey), headers: {} };
  return sessionAuth(provider.kind, await activeSession(provider.id, provider.kind));
}

export async function deploymentAuth(dep: ResolvedDeployment): Promise<UpstreamAuth> {
  if (dep.provider && isSignInKind(dep.provider.kind) && dep.provider.kind !== dep.kind) {
    throw new GateError(503, "no_provider_key", "deployment kind does not match its signed-in provider");
  }
  const auth = dep.provider ? await providerAuth(dep.provider) : { key: "", headers: {} };
  if (!auth.key && dep.kind !== "openai_compat") {
    throw new GateError(503, "no_provider_key", "no API key for deployment");
  }
  return auth;
}
