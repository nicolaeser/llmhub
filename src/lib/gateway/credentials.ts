import "server-only";
import prisma from "@/lib/db/prisma";
import { open, seal } from "@/lib/crypto";
import { isSignInKind } from "@/lib/gateway/catalog";
import { asRecord, asString, VERSION } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { refreshSession } from "@/lib/gateway/sign-in";
import { logger } from "@/lib/logging/logger";
import type { ResolvedDeployment, UpstreamAuth } from "@/types/gateway";
import type { SignInKind, SignInSession, SignInTokens } from "@/types/providers";

const REFRESH_SKEW_MS = 5 * 60_000;
const LEASE_MS = 30_000;
const LEASE_WAIT_MS = 10_000;
const LEASE_POLL_MS = 250;
const CODEX_ORIGINATOR = "llmhub";

const refreshing = new Map<string, Promise<SignInSession>>();

type LoginRow = {
  providerId: string;
  account: string;
  plan: string;
  tokens: string;
  expiresAt: Date;
  status: string;
  version: number;
};

function signInRequired(): GateError {
  return new GateError(503, "no_provider_key", "provider sign-in expired; sign in again on the Providers page");
}

export function sealTokens(tokens: SignInTokens): string {
  return seal(JSON.stringify(tokens));
}

function openTokens(sealed: string): SignInTokens {
  let rec: Record<string, unknown> | null = null;
  try {
    rec = asRecord(JSON.parse(open(sealed)));
  } catch {}
  return {
    access: asString(rec?.access),
    refresh: asString(rec?.refresh),
    accountId: asString(rec?.accountId),
    residency: asString(rec?.residency),
  };
}

function sessionOf(row: LoginRow): SignInSession {
  return { tokens: openTokens(row.tokens), expiresAt: row.expiresAt.getTime(), account: row.account, plan: row.plan };
}

function fresh(session: SignInSession, now = Date.now()): boolean {
  return Boolean(session.tokens.access) && session.expiresAt - now > REFRESH_SKEW_MS;
}

export function signInHeaders(kind: SignInKind, tokens: SignInTokens): Record<string, string> {
  if (kind !== "codex") return {};
  const headers: Record<string, string> = {
    "ChatGPT-Account-ID": tokens.accountId,
    originator: CODEX_ORIGINATOR,
    "User-Agent": `LLMHub/${VERSION}`,
  };
  if (tokens.residency) headers["x-openai-internal-codex-residency"] = tokens.residency;
  return headers;
}

export function loginData(session: SignInSession) {
  return {
    account: session.account,
    plan: session.plan,
    tokens: sealTokens(session.tokens),
    expiresAt: new Date(session.expiresAt),
    status: "active",
    leaseUntil: null,
  };
}

export async function saveLogin(providerId: string, session: SignInSession): Promise<void> {
  const data = loginData(session);
  await prisma.providerLogin.upsert({
    where: { providerId },
    create: { providerId, ...data },
    update: { ...data, version: { increment: 1 } },
  });
}

async function loadLogin(providerId: string): Promise<LoginRow> {
  const row = await prisma.providerLogin.findUnique({ where: { providerId } });
  if (!row || row.status !== "active") throw signInRequired();
  return row;
}

async function renew(row: LoginRow, current: SignInSession, kind: SignInKind): Promise<SignInSession> {
  const outcome = await refreshSession(kind, current);
  if (outcome.ok) {
    await prisma.providerLogin.update({
      where: { providerId: row.providerId },
      data: { ...loginData(outcome.session), version: { increment: 1 } },
    });
    return outcome.session;
  }
  await prisma.providerLogin.update({
    where: { providerId: row.providerId },
    data: { leaseUntil: null, ...(outcome.fatal ? { status: "expired" } : {}) },
  });
  logger.warn("provider.sign_in_refresh_failed", { provider: row.providerId, kind, fatal: outcome.fatal });
  if (!outcome.fatal && current.tokens.access && current.expiresAt > Date.now()) return current;
  throw signInRequired();
}

async function refreshLogin(providerId: string, kind: SignInKind): Promise<SignInSession> {
  const deadline = Date.now() + LEASE_WAIT_MS;
  for (;;) {
    const row = await loadLogin(providerId);
    const session = sessionOf(row);
    if (fresh(session)) return session;
    const now = new Date();
    const claimed = await prisma.providerLogin.updateMany({
      where: {
        providerId,
        version: row.version,
        status: "active",
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count === 1) return renew(row, session, kind);
    if (Date.now() > deadline) {
      if (session.tokens.access && session.expiresAt > Date.now()) return session;
      throw signInRequired();
    }
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
  }
}

async function activeSession(providerId: string, kind: SignInKind): Promise<SignInSession> {
  const session = sessionOf(await loadLogin(providerId));
  if (fresh(session)) return session;
  const pending = refreshing.get(providerId);
  if (pending) return pending;
  const started = refreshLogin(providerId, kind).finally(() => refreshing.delete(providerId));
  refreshing.set(providerId, started);
  return started;
}

export async function providerAuth(provider: { id: string; kind: string; apiKey: string }): Promise<UpstreamAuth> {
  if (!isSignInKind(provider.kind)) return { key: open(provider.apiKey), headers: {} };
  const session = await activeSession(provider.id, provider.kind);
  return { key: session.tokens.access, headers: signInHeaders(provider.kind, session.tokens) };
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
