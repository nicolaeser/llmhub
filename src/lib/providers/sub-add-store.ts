import "server-only";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { digest } from "@/lib/crypto";
import { withSerializableRetry } from "@/lib/db/serializable";
import { scheduleCatalogTask } from "@/lib/gateway/catalog/catalog-tasks";
import { reactivateAccount } from "@/lib/gateway/routing/account-reactivation";
import { loginData } from "@/lib/gateway/upstreams/credentials";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { matchingConnection, pruneSupersededLogins } from "@/lib/providers/account-match";
import { providerAuditAfter, providerInclude } from "@/lib/providers/connections";
import { removeProviderConnection } from "@/lib/providers/provider-removal";
import { auditSubAddDelete, subAddAuditSelect } from "@/lib/providers/sub-add-prune";
import { subAddStatus } from "@/lib/providers/sub-add-status";
import type { SignInKind, SignInSession } from "@/types/providers";
import type { SubAddAccountRecord, SubAddAccountView, SubAddOutcome } from "@/types/sub-add";

const SUB_ADD_TOKEN_BYTES = 32;
const STORE_ATTEMPTS = 6;

export const SUB_ADD_UNAVAILABLE = "SUB_ADD_UNAVAILABLE";
export const SUB_ADD_LOGIN_INVALID = "SUB_ADD_LOGIN_INVALID";
export const SUB_ADD_LOGIN_UNVERIFIED = "SUB_ADD_LOGIN_UNVERIFIED";

export function subAddTokenHash(token: string): string {
  return digest(token);
}

export function newSubAddToken(): { token: string; hash: string } {
  const token = randomBytes(SUB_ADD_TOKEN_BYTES).toString("base64url");
  return { token, hash: subAddTokenHash(token) };
}

export function subAddUid(linkId: string): string {
  return `sub-add:${linkId}`;
}

export const subAddAccountSelect = {
  providerId: true,
  createdAt: true,
  provider: {
    select: { kind: true, enabled: true, login: { select: { account: true, plan: true, status: true } } },
  },
} as const;

export function subAddAccountViews(rows: SubAddAccountRecord[]): SubAddAccountView[] {
  return rows.flatMap((row): SubAddAccountView[] => {
    const kind = row.provider.kind;
    if (!isSignInKind(kind)) return [];
    return [
      {
        providerId: row.providerId,
        kind,
        account: row.provider.login?.account ?? "",
        plan: row.provider.login?.plan ?? "",
        status: row.provider.login?.status === "active" ? "active" : "expired",
        enabled: row.provider.enabled,
        addedAt: row.createdAt.toISOString(),
      },
    ];
  });
}

async function liveManageHash(
  tx: Prisma.TransactionClient,
  brought: string | undefined,
  fresh: string,
): Promise<string> {
  if (brought && (await tx.subAddAccount.count({ where: { manageHash: brought } }))) return brought;
  return fresh;
}

export async function storeSubAddAccount(input: {
  linkId: string;
  kind: SignInKind;
  session: SignInSession;
  manageHash: string;
  broughtManageHash?: string;
  loginVerified: boolean;
  now?: number;
}): Promise<{ providerId: string; outcome: SubAddOutcome; manageHash: string }> {
  const spec = PROVIDER_CATALOG.find((item) => item.kind === input.kind);
  const baseUrl = spec?.default_base_url ?? "";
  const login = loginData(input.session);
  const stored = await withSerializableRetry(async (tx) => {
    const link = await tx.subAddLink.findUnique({ where: { id: input.linkId }, select: subAddAuditSelect });
    if (!link || !link.kinds.includes(input.kind)) throw new Error(SUB_ADD_UNAVAILABLE);
    if (subAddStatus(link, input.now ?? Date.now()) !== "active") throw new Error(SUB_ADD_UNAVAILABLE);
    const manageHash = await liveManageHash(tx, input.broughtManageHash, input.manageHash);
    const existing = await matchingConnection(input.kind, input.session, tx);
    if (existing) {
      if (!input.loginVerified) throw new Error(SUB_ADD_LOGIN_UNVERIFIED);
      const row = await tx.providerConnection.update({
        where: { id: existing },
        data: {
          ...(baseUrl ? { baseUrl } : {}),
          login: { upsert: { create: login, update: { ...login, version: { increment: 1 } } } },
          subAdd: {
            upsert: {
              create: { linkId: null, label: link.label, manageHash },
              update: { manageHash },
            },
          },
        },
        include: providerInclude,
      });
      return { row, link, manageHash, outcome: "updated" as const, usedUp: false };
    }
    const added = link.added + 1;
    const usedUp = link.maxAccounts !== null && added >= link.maxAccounts;
    await tx.subAddLink.update({ where: { id: link.id }, data: { added: { increment: 1 } } });
    const row = await tx.providerConnection.create({
      data: {
        name: spec?.name ?? input.kind,
        kind: input.kind,
        baseUrl,
        apiKey: "",
        restricted: link.restricted,
        login: { create: login },
        subAdd: { create: { linkId: link.id, label: link.label, manageHash } },
        ...(link.restricted && link.targets.length ? { assignments: { create: link.targets } } : {}),
      },
      include: providerInclude,
    });
    if (usedUp) await tx.subAddLink.delete({ where: { id: link.id } });
    return { row, link: { ...link, added }, manageHash, outcome: "created" as const, usedUp };
  }, STORE_ATTEMPTS);
  if (stored.outcome === "updated") await reactivateAccount(stored.row.id);
  const actor = subAddUid(stored.link.id);
  await writeAudit({
    actor,
    action: "provider.sub_add_added",
    objectType: "provider",
    objectId: stored.row.id,
    after: providerAuditAfter(stored.row, {
      outcome: stored.outcome,
      linkId: stored.link.id,
      restricted: stored.row.restricted,
      signInAccount: input.session.account,
      plan: input.session.plan,
    }),
  });
  if (stored.usedUp) await auditSubAddDelete(actor, stored.link, "used_up");
  await scheduleCatalogTask({ task: "provider", providerId: stored.row.id });
  await pruneSupersededLogins(actor);
  return { providerId: stored.row.id, outcome: stored.outcome, manageHash: stored.manageHash };
}

type ManagedAccount = { providerId: string; linkId: string | null };

const managedAccountSelect = { providerId: true, linkId: true } as const;

async function auditManageChange(action: string, accounts: ManagedAccount[]): Promise<void> {
  for (const account of accounts) {
    await writeAudit({
      actor: account.linkId ? subAddUid(account.linkId) : "sub-add",
      action,
      objectType: "provider",
      objectId: account.providerId,
      after: { linkId: account.linkId, accounts: accounts.length },
    });
  }
}

export async function revokeSubAddManageHash(manageHash: string): Promise<number> {
  const revoked = await withSerializableRetry((tx) =>
    tx.subAddAccount.updateManyAndReturn({
      where: { manageHash },
      data: { manageHash: null },
      select: managedAccountSelect,
    }),
  );
  if (!revoked.length) throw new Error(SUB_ADD_UNAVAILABLE);
  await auditManageChange("provider_sub_add.manage_revoke", revoked);
  return revoked.length;
}

export async function renewSubAddManageHash(manageHash: string, nextHash: string): Promise<number> {
  const moved = await withSerializableRetry((tx) =>
    tx.subAddAccount.updateManyAndReturn({
      where: { manageHash },
      data: { manageHash: nextHash },
      select: managedAccountSelect,
    }),
  );
  if (!moved.length) throw new Error(SUB_ADD_UNAVAILABLE);
  await auditManageChange("provider_sub_add.manage_renew", moved);
  return moved.length;
}

export async function removeSubAddAccount(providerId: string, manageHash: string): Promise<void> {
  const owned = await prisma.subAddAccount.findFirst({
    where: { providerId, manageHash },
    select: { linkId: true },
  });
  if (!owned) throw new Error("NOT_FOUND");
  const result = await removeProviderConnection(providerId);
  await writeAudit({
    actor: owned.linkId ? subAddUid(owned.linkId) : "sub-add",
    action: "provider.sub_add_removed",
    objectType: "provider",
    objectId: result.row.id,
    after: providerAuditAfter(result.row, {
      linkId: owned.linkId,
      removedRoutes: result.routes,
      removedGroups: result.removedGroups,
      emptyGroups: result.emptyGroups,
    }),
  });
  await scheduleCatalogTask({ task: "rebuild" });
}
