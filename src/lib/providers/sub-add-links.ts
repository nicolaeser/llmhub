import "server-only";
import prisma from "@/lib/db/prisma";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { requireStepUp } from "@/lib/auth/second-factor";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import {
  assignmentColumns,
  assignmentSelect,
  assignmentTargets,
  targetsMissing,
} from "@/lib/gateway/routing/account-assignments";
import { isSignInKind, signInKinds } from "@/lib/gateway/upstreams/provider-kinds";
import { subAddPath } from "@/lib/http/public-path";
import { auditSubAddDelete, finishedSubAddLinks, subAddLinkAudit } from "@/lib/providers/sub-add-prune";
import { newSubAddToken, subAddAccountSelect, subAddAccountViews } from "@/lib/providers/sub-add-store";
import { subAddLinkCreateSchema } from "@/schemas/sub-add";
import type { SignInKind } from "@/types/providers";
import type { SubAddCreated, SubAddLinksPayload, SubAddLinkView } from "@/types/sub-add";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;

const linkSelect = {
  id: true,
  label: true,
  kinds: true,
  maxAccounts: true,
  added: true,
  restricted: true,
  expiresAt: true,
  createdAt: true,
  createdById: true,
  targets: assignmentSelect,
  accounts: { select: subAddAccountSelect, orderBy: { createdAt: "asc" } },
} as const;

type LinkRow = NonNullable<Awaited<ReturnType<typeof findLink>>>;

function findLink(id: string) {
  return prisma.subAddLink.findUnique({ where: { id }, select: linkSelect });
}

async function creatorNames(ids: string[]): Promise<Map<string, string>> {
  const known = [...new Set(ids.filter(Boolean))];
  if (!known.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: known } }, select: { id: true, username: true } });
  return new Map(users.map((user) => [user.id, user.username]));
}

function linkView(row: LinkRow, names: Map<string, string>): SubAddLinkView {
  return {
    id: row.id,
    label: row.label,
    kinds: row.kinds.filter((kind): kind is SignInKind => isSignInKind(kind)),
    maxAccounts: row.maxAccounts,
    added: row.added,
    restricted: row.restricted,
    targets: assignmentTargets(row.targets),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdBy: names.get(row.createdById) ?? "",
    accounts: subAddAccountViews(row.accounts),
  };
}

async function viewOf(row: LinkRow): Promise<SubAddLinkView> {
  return linkView(row, await creatorNames([row.createdById]));
}

export async function loadSubAddLinks(): Promise<SubAddLinksPayload> {
  const session = await requirePlatformPermission(PERMISSIONS.PROVIDERS_READ);
  const rows = await prisma.subAddLink.findMany({
    where: { NOT: finishedSubAddLinks(new Date()) },
    select: linkSelect,
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
  });
  const names = await creatorNames(rows.map((row) => row.createdById));
  return {
    links: rows.map((row) => linkView(row, names)),
    kinds: signInKinds(),
    canManage: hasPerm(session.permissions, PERMISSIONS.PROVIDERS_MANAGE),
  };
}

export async function createSubAddLink(raw: unknown): Promise<SubAddCreated> {
  const session = await requirePlatformPermission(PERMISSIONS.PROVIDERS_MANAGE);
  const parsed = subAddLinkCreateSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const input = parsed.data;
  const kinds = [...new Set(input.kinds)];
  if (!kinds.every(isSignInKind)) throw new Error("UNKNOWN_PROVIDER_KIND");
  const targets = input.restricted ? input.targets : [];
  if (await targetsMissing(targets)) throw new Error("NOT_FOUND");
  await requireStepUp(session.user.id, input.code);
  const { token, hash } = newSubAddToken();
  const row = await prisma.subAddLink.create({
    data: {
      label: input.label,
      tokenHash: hash,
      kinds,
      maxAccounts: input.maxAccounts,
      restricted: input.restricted,
      expiresAt: new Date(Date.now() + input.days * DAY_MS),
      createdById: session.user.id,
      targets: { create: assignmentColumns(targets) },
    },
    select: linkSelect,
  });
  await writeAudit({
    actor: session.user.id,
    action: "provider_sub_add.create",
    objectType: "provider_sub_add",
    objectId: row.id,
    after: subAddLinkAudit(row),
  });
  return {
    link: await viewOf(row),
    url: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}${subAddPath(token)}`,
  };
}

export async function deleteSubAddLink(id: string): Promise<{ id: string }> {
  const session = await requirePlatformPermission(PERMISSIONS.PROVIDERS_MANAGE);
  if (!id) throw new Error("MISSING_ID");
  const row = await findLink(id);
  if (!row) throw new Error("NOT_FOUND");
  const deleted = await prisma.subAddLink.deleteMany({ where: { id } });
  if (!deleted.count) throw new Error("NOT_FOUND");
  await auditSubAddDelete(session.user.id, row, "revoked");
  return { id };
}
