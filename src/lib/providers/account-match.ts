import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { scheduleCatalogTask } from "@/lib/gateway/catalog/catalog-tasks";
import { openTokens } from "@/lib/gateway/upstreams/credentials";
import { removeProviderConnection } from "@/lib/providers/provider-removal";
import type { SignInKind, SignInSession } from "@/types/providers";

const SUPERSEDED_BATCH = 50;

type StoredLogin = { id: string; accountId: string; active: boolean };

function storedAccountId(tokens: string, providerId: string): string {
  try {
    return openTokens(tokens, providerId).accountId;
  } catch {
    return "";
  }
}

function sameAccountId(left: string, right: string): boolean {
  return !left || !right || left === right;
}

export function preferredLogin(rows: StoredLogin[], accountId: string): StoredLogin | null {
  const exact = accountId ? rows.filter((row) => row.accountId === accountId) : [];
  const candidates = exact.length ? exact : rows.filter((row) => !accountId || !row.accountId);
  return candidates.find((row) => row.active) ?? candidates[0] ?? null;
}

export async function matchingConnection(
  kind: SignInKind,
  session: SignInSession,
  db: Prisma.TransactionClient = prisma,
): Promise<string | null> {
  const account = session.account.trim();
  if (!account) return null;
  const rows = await db.providerConnection.findMany({
    where: { kind, login: { is: { account: { equals: account, mode: "insensitive" } } } },
    select: { id: true, login: { select: { tokens: true, status: true } } },
    orderBy: { createdAt: "asc" },
  });
  const stored = rows.map((row) => ({
    id: row.id,
    accountId: row.login ? storedAccountId(row.login.tokens, row.id) : "",
    active: row.login?.status === "active",
  }));
  return preferredLogin(stored, session.tokens.accountId)?.id ?? null;
}

export async function pruneSupersededLogins(actor: string): Promise<string[]> {
  const expired = await prisma.providerLogin.findMany({
    where: { status: "expired", account: { not: "" } },
    select: { providerId: true, account: true, tokens: true, provider: { select: { kind: true } } },
    orderBy: { createdAt: "asc" },
    take: SUPERSEDED_BATCH,
  });
  if (!expired.length) return [];
  const active = await prisma.providerLogin.findMany({
    where: {
      status: "active",
      account: { not: "" },
      provider: { kind: { in: [...new Set(expired.map((row) => row.provider.kind))] } },
    },
    select: { providerId: true, account: true, tokens: true, provider: { select: { kind: true } } },
  });
  const removed: string[] = [];
  for (const row of expired) {
    const account = row.account.trim().toLowerCase();
    const accountId = storedAccountId(row.tokens, row.providerId);
    const successor = active.find(
      (candidate) =>
        candidate.providerId !== row.providerId &&
        candidate.provider.kind === row.provider.kind &&
        candidate.account.trim().toLowerCase() === account &&
        sameAccountId(accountId, storedAccountId(candidate.tokens, candidate.providerId)),
    );
    if (!successor) continue;
    const result = await removeProviderConnection(row.providerId).catch(() => null);
    if (!result) continue;
    removed.push(row.providerId);
    await writeAudit({
      actor,
      action: "provider.superseded",
      objectType: "provider",
      objectId: row.providerId,
      after: {
        name: result.row.name,
        kind: result.row.kind,
        signInAccount: row.account,
        supersededBy: successor.providerId,
        removedRoutes: result.routes,
        removedGroups: result.removedGroups,
      },
    });
  }
  if (removed.length) await scheduleCatalogTask({ task: "rebuild" });
  return removed;
}
