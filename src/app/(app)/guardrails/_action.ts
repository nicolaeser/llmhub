"use server";

import prisma from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { keyScope, keyVisibleTo } from "@/lib/auth/scope";
import { actionFail, runAction } from "@/lib/http/action-result";
import { writeAudit } from "@/lib/gateway/audit";
import { testGuardrails } from "@/lib/gateway/guardrails";
import {
  getGuardrails,
  getPii,
  guardrailOverride,
  piiOverride,
  saveGuardrails,
  savePii,
} from "@/lib/gateway/settings";
import { redactPii } from "@/lib/gateway/pii";
import {
  guardrailOverrideSchema,
  guardrailPolicySchema,
  guardrailTestSchema,
  piiOverrideSchema,
} from "@/schemas/guardrails";
import type { PIIConfig } from "@/types/gateway";
import type {
  GuardrailOverrideView,
  GuardrailPolicy,
  PiiOverrideView,
  PiiPolicy,
  PolicyScope,
  PolicyTarget,
} from "@/types/guardrails";
import type { z } from "zod";

type Session = Awaited<ReturnType<typeof requirePermission>>;

type PolicyColumns = { piiPolicy: unknown; guardrailPolicy: unknown };

type TargetRow = { target: PolicyTarget } & PolicyColumns;

type JsonColumn = Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;

const POLICY_SELECT = { piiPolicy: true, guardrailPolicy: true } as const;

const ORG_SELECT = { id: true, alias: true, ...POLICY_SELECT } as const;

const PROJECT_SELECT = { id: true, alias: true, orgId: true, ...POLICY_SELECT } as const;

const KEY_SELECT = {
  id: true,
  keyAlias: true,
  prefix: true,
  orgId: true,
  projectId: true,
  userId: true,
  ...POLICY_SELECT,
} as const;

const PATTERN_ISSUES = new Set(["invalid", "nested_quantifier", "matches_empty"]);

function orgRow(row: { id: string; alias: string } & PolicyColumns): TargetRow {
  return { target: { scope: "org", id: row.id, alias: row.alias, orgId: row.id, projectId: "" }, ...row };
}

function projectRow(row: { id: string; alias: string; orgId: string | null } & PolicyColumns): TargetRow {
  return {
    target: { scope: "project", id: row.id, alias: row.alias, orgId: row.orgId ?? "", projectId: row.id },
    ...row,
  };
}

function keyRow(
  row: { id: string; keyAlias: string; prefix: string; orgId: string | null; projectId: string | null } & PolicyColumns,
): TargetRow {
  return {
    target: {
      scope: "key",
      id: row.id,
      alias: row.keyAlias || row.prefix,
      orgId: row.orgId ?? "",
      projectId: row.projectId ?? "",
    },
    ...row,
  };
}

function piiOverrideOf(target: PolicyTarget, raw: unknown): PiiOverrideView | null {
  const policy = piiOverride(raw);
  return policy ? { ...target, policy } : null;
}

function guardrailOverrideOf(target: PolicyTarget, raw: unknown): GuardrailOverrideView | null {
  const policy = guardrailOverride(raw);
  return policy ? { ...target, policy } : null;
}

function byAlias(a: PolicyTarget, b: PolicyTarget) {
  return a.alias.localeCompare(b.alias);
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

function policyFailure(error: z.ZodError): string {
  if (error.issues.some((issue) => PATTERN_ISSUES.has(issue.message))) return "INVALID_PATTERN";
  if (error.issues.some((issue) => issue.message === "duplicate")) return "NAME_EXISTS";
  return "VALIDATION";
}

async function payload(session: Session) {
  const [pii, guardrails, orgs, projects, keys] = await Promise.all([
    getPii(),
    getGuardrails(),
    prisma.organization.findMany({ select: ORG_SELECT, orderBy: { alias: "asc" } }),
    prisma.project.findMany({ select: PROJECT_SELECT, orderBy: { alias: "asc" } }),
    prisma.virtualKey.findMany({
      where: keyScope(session),
      select: KEY_SELECT,
      orderBy: { keyAlias: "asc" },
    }),
  ]);
  const rows = [...orgs.map(orgRow), ...projects.map(projectRow), ...keys.map(keyRow)];
  return {
    pii,
    guardrails,
    piiOverrides: rows.map((row) => piiOverrideOf(row.target, row.piiPolicy)).filter(present).sort(byAlias),
    guardrailOverrides: rows
      .map((row) => guardrailOverrideOf(row.target, row.guardrailPolicy))
      .filter(present)
      .sort(byAlias),
    targets: rows.map((row) => row.target),
    canManage: hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE),
  };
}

async function findTarget(session: Session, scope: PolicyScope, id: string): Promise<TargetRow | null> {
  if (scope === "org") {
    const row = await prisma.organization.findUnique({ where: { id }, select: ORG_SELECT });
    return row ? orgRow(row) : null;
  }
  if (scope === "project") {
    const row = await prisma.project.findUnique({ where: { id }, select: PROJECT_SELECT });
    return row ? projectRow(row) : null;
  }
  const row = await prisma.virtualKey.findUnique({ where: { id }, select: KEY_SELECT });
  if (!row || !keyVisibleTo(session, row)) return null;
  return keyRow(row);
}

async function writeOverride(
  scope: PolicyScope,
  id: string,
  data: { piiPolicy: JsonColumn } | { guardrailPolicy: JsonColumn },
) {
  if (scope === "org") {
    await prisma.organization.update({ where: { id }, data });
    return;
  }
  if (scope === "project") {
    await prisma.project.update({ where: { id }, data });
    return;
  }
  await prisma.virtualKey.update({ where: { id }, data });
}

export async function loadGuardrailsAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
    return payload(session);
  });
}

export async function savePiiAction(pii: PIIConfig) {
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
    const policy: PiiPolicy | null = piiOverride(parsed.data.policy);
    await writeOverride(scope, id, { piiPolicy: policy ?? Prisma.DbNull });
    await writeAudit({
      actor: session.user.id,
      action: "pii.override",
      objectType: scope,
      objectId: id,
      before: piiOverride(existing.piiPolicy),
      after: policy,
    });
    return { scope, id, override: piiOverrideOf(existing.target, policy) };
  });
}

export async function saveGuardrailPolicyAction(raw: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const parsed = guardrailPolicySchema.safeParse(raw);
    if (!parsed.success) return actionFail(policyFailure(parsed.error));
    const before = await getGuardrails();
    const saved = await saveGuardrails(parsed.data);
    await writeAudit({
      actor: session.user.id,
      action: "settings.guardrails",
      objectType: "guardrails",
      objectId: "guardrails",
      before,
      after: saved,
    });
    return { guardrails: saved };
  });
}

export async function saveGuardrailOverrideAction(raw: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const parsed = guardrailOverrideSchema.safeParse(raw);
    if (!parsed.success) return actionFail(policyFailure(parsed.error));
    const { scope, id } = parsed.data;
    const existing = await findTarget(session, scope, id);
    if (!existing) return actionFail("NOT_FOUND");
    const policy: GuardrailPolicy | null = guardrailOverride(parsed.data.policy);
    await writeOverride(scope, id, { guardrailPolicy: policy ?? Prisma.DbNull });
    await writeAudit({
      actor: session.user.id,
      action: "guardrails.override",
      objectType: scope,
      objectId: id,
      before: guardrailOverride(existing.guardrailPolicy),
      after: policy,
    });
    return { scope, id, override: guardrailOverrideOf(existing.target, policy) };
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

export async function testGuardrailsAction(raw: unknown) {
  return runAction(async () => {
    await requirePermission(PERMISSIONS.SETTINGS_READ);
    const parsed = guardrailTestSchema.safeParse(raw);
    if (!parsed.success) return actionFail(policyFailure(parsed.error));
    return testGuardrails(parsed.data.text, parsed.data.policy, parsed.data.direction);
  });
}
