import "server-only";
import { randomBytes } from "node:crypto";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { digest } from "@/lib/crypto";
import { withSerializableRetry } from "@/lib/db/serializable";
import { scheduleCatalogTask } from "@/lib/gateway/catalog/catalog-tasks";
import { loginData } from "@/lib/gateway/upstreams/credentials";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { matchingConnection, pruneSupersededLogins } from "@/lib/providers/account-match";
import { providerAuditAfter, providerInclude } from "@/lib/providers/connections";
import { removeProviderConnection } from "@/lib/providers/provider-removal";
import { subAddStatus } from "@/lib/providers/sub-add-status";
import type { SignInKind, SignInSession } from "@/types/providers";
import type { SubAddAccountRecord, SubAddAccountView, SubAddOutcome } from "@/types/sub-add";

const SUB_ADD_TOKEN_BYTES = 32;
const STORE_ATTEMPTS = 6;

export const SUB_ADD_UNAVAILABLE = "SUB_ADD_UNAVAILABLE";

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

export async function storeSubAddAccount(input: {
  linkId: string;
  kind: SignInKind;
  session: SignInSession;
  manageHash: string;
  now?: number;
}): Promise<{ providerId: string; outcome: SubAddOutcome }> {
  const spec = PROVIDER_CATALOG.find((item) => item.kind === input.kind);
  const baseUrl = spec?.default_base_url ?? "";
  const login = loginData(input.session);
  const stored = await withSerializableRetry(async (tx) => {
    const link = await tx.subAddLink.findUnique({
      where: { id: input.linkId },
      select: {
        id: true,
        kinds: true,
        maxAccounts: true,
        added: true,
        restricted: true,
        expiresAt: true,
        revokedAt: true,
        targets: { select: { orgId: true, teamId: true, projectId: true, memberId: true, keyId: true } },
      },
    });
    if (!link || !link.kinds.includes(input.kind)) throw new Error(SUB_ADD_UNAVAILABLE);
    const status = subAddStatus(link, input.now ?? Date.now());
    if (status === "revoked" || status === "expired") throw new Error(SUB_ADD_UNAVAILABLE);
    const existing = await matchingConnection(input.kind, input.session, tx);
    if (existing) {
      const row = await tx.providerConnection.update({
        where: { id: existing },
        data: {
          ...(baseUrl ? { baseUrl } : {}),
          login: { upsert: { create: login, update: { ...login, version: { increment: 1 } } } },
          subAdd: {
            upsert: {
              create: { linkId: link.id, manageHash: input.manageHash },
              update: { manageHash: input.manageHash },
            },
          },
        },
        include: providerInclude,
      });
      return { row, linkId: link.id, outcome: "updated" as const };
    }
    if (status !== "active") throw new Error(SUB_ADD_UNAVAILABLE);
    const row = await tx.providerConnection.create({
      data: {
        name: spec?.name ?? input.kind,
        kind: input.kind,
        baseUrl,
        apiKey: "",
        restricted: link.restricted,
        login: { create: login },
        subAdd: { create: { linkId: link.id, manageHash: input.manageHash } },
        ...(link.restricted && link.targets.length ? { assignments: { create: link.targets } } : {}),
      },
      include: providerInclude,
    });
    await tx.subAddLink.update({ where: { id: link.id }, data: { added: { increment: 1 } } });
    return { row, linkId: link.id, outcome: "created" as const };
  }, STORE_ATTEMPTS);
  await writeAudit({
    actor: subAddUid(stored.linkId),
    action: "provider.sub_add_added",
    objectType: "provider",
    objectId: stored.row.id,
    after: providerAuditAfter(stored.row, {
      outcome: stored.outcome,
      linkId: stored.linkId,
      restricted: stored.row.restricted,
      signInAccount: input.session.account,
      plan: input.session.plan,
    }),
  });
  await scheduleCatalogTask({ task: "provider", providerId: stored.row.id });
  await pruneSupersededLogins(subAddUid(stored.linkId));
  return { providerId: stored.row.id, outcome: stored.outcome };
}

export async function removeSubAddAccount(providerId: string, manageHash: string): Promise<void> {
  const owned = await prisma.subAddAccount.findFirst({
    where: { providerId, manageHash },
    select: { linkId: true },
  });
  if (!owned) throw new Error("NOT_FOUND");
  const result = await removeProviderConnection(providerId);
  await writeAudit({
    actor: subAddUid(owned.linkId),
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
