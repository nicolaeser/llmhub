"use server";

import prisma from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { keyVisibleTo, seesAllResources } from "@/lib/auth/scope";
import { actionFail, runAction } from "@/lib/http/action-result";
import { writeAudit } from "@/lib/gateway/audit";
import { getPii, piiOverride, savePii } from "@/lib/gateway/settings";
import { redactPii } from "@/lib/gateway/pii";
import { piiOverrideSchema } from "@/schemas/guardrails";
import type { PIIConfig } from "@/types/gateway";
import type { PiiOverrideView, PiiPolicy, PiiScope, PiiTarget } from "@/types/guardrails";

type Session = Awaited<ReturnType<typeof requirePermission>>;

type OrgRow = { id: string; alias: string; piiPolicy: unknown };

type KeyRow = {
  id: string;
  keyAlias: string;
  prefix: string;
  orgId: string | null;
  userId: string | null;
  piiPolicy: unknown;
};

const ORG_SELECT = { id: true, alias: true, piiPolicy: true } as const;

const KEY_SELECT = {
  id: true,
  keyAlias: true,
  prefix: true,
  orgId: true,
  userId: true,
  piiPolicy: true,
} as const;

function orgTarget(row: OrgRow): PiiTarget {
  return { scope: "org", id: row.id, alias: row.alias, orgId: row.id };
}

function keyTarget(row: KeyRow): PiiTarget {
  return { scope: "key", id: row.id, alias: row.keyAlias || row.prefix, orgId: row.orgId ?? "" };
}

function overrideOf(target: PiiTarget, raw: unknown): PiiOverrideView | null {
  const policy = piiOverride(raw);
  return policy ? { ...target, policy } : null;
}

function byAlias(a: PiiTarget, b: PiiTarget) {
  return a.alias.localeCompare(b.alias);
}

async function payload(session: Session, pii: PiiPolicy) {
  const [orgs, keys] = await Promise.all([
    prisma.organization.findMany({ select: ORG_SELECT, orderBy: { alias: "asc" } }),
    prisma.virtualKey.findMany({
      where: seesAllResources(session) ? {} : { userId: session.user.id },
      select: KEY_SELECT,
      orderBy: { keyAlias: "asc" },
    }),
  ]);
  const rows = [
    ...orgs.map((row) => ({ target: orgTarget(row), raw: row.piiPolicy })),
    ...keys.map((row) => ({ target: keyTarget(row), raw: row.piiPolicy })),
  ];
  return {
    pii,
    overrides: rows
      .map((row) => overrideOf(row.target, row.raw))
      .filter((row): row is PiiOverrideView => row !== null)
      .sort(byAlias),
    targets: rows.map((row) => row.target),
    canManage: hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE),
  };
}

async function findTarget(session: Session, scope: PiiScope, id: string) {
  if (scope === "org") {
    const row = await prisma.organization.findUnique({ where: { id }, select: ORG_SELECT });
    return row ? { target: orgTarget(row), raw: row.piiPolicy } : null;
  }
  const row = await prisma.virtualKey.findUnique({ where: { id }, select: KEY_SELECT });
  if (!row || !keyVisibleTo(session, row.userId)) return null;
  return { target: keyTarget(row), raw: row.piiPolicy };
}

async function writePolicy(scope: PiiScope, id: string, policy: PiiPolicy | null) {
  const piiPolicy = policy ?? Prisma.DbNull;
  if (scope === "org") {
    await prisma.organization.update({ where: { id }, data: { piiPolicy } });
    return;
  }
  await prisma.virtualKey.update({ where: { id }, data: { piiPolicy } });
}

export async function loadGuardrailsAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
    return payload(session, await getPii());
  });
}

export async function saveGuardrailsAction(pii: PIIConfig) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const saved = await savePii(pii);
    await writeAudit({
      actor: session.user.id,
      action: "settings.pii",
      objectType: "pii",
      objectId: "pii",
      after: saved,
    });
    return { pii: saved };
  });
}

export async function savePiiOverrideAction(raw: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const parsed = piiOverrideSchema.safeParse(raw);
    if (!parsed.success) return actionFail("VALIDATION");
    const { scope, id } = parsed.data;
    const existing = await findTarget(session, scope, id);
    if (!existing) return actionFail("NOT_FOUND");
    const policy = piiOverride(parsed.data.policy);
    await writePolicy(scope, id, policy);
    await writeAudit({
      actor: session.user.id,
      action: "pii.override",
      objectType: scope,
      objectId: id,
      before: piiOverride(existing.raw),
      after: policy,
    });
    return { scope, id, override: overrideOf(existing.target, policy) };
  });
}

export async function testPiiAction(text: string) {
  return runAction(async () => {
    await requirePermission(PERMISSIONS.SETTINGS_READ);
    const pii = await getPii();
    if (pii.enabled === false) return { redacted: text };
    return { redacted: redactPii(text, pii.entities) };
  });
}
