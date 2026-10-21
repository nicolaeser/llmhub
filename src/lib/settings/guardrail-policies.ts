import "server-only";

import prisma from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { assertPlatform, companyOf, inCompany, keyScope, keyVisibleTo } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/audit";
import { testGuardrails as evaluateGuardrails } from "@/lib/gateway/safety/guardrails";
import {
  getGuardrails,
  getPii,
  guardrailOverride,
  piiOverride,
  saveGuardrails,
  savePii as storePii,
} from "@/lib/settings/enterprise";
import { redactPii } from "@/lib/gateway/safety/pii";
import {
  guardrailOverrideSchema,
  guardrailPolicySchema,
  guardrailTestSchema,
  piiOverrideSchema,
  piiPolicySchema,
} from "@/schemas/guardrails";
import type {
  CompanyPolicies,
  GuardrailOverrideView,
  GuardrailPolicy,
  GuardrailSummary,
  PiiOverrideView,
  PiiPolicy,
  PiiSummary,
  PolicyOverrideSummary,
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
  const company = companyOf(session);
  const [pii, guardrails, orgs, projects, keys] = await Promise.all([
    getPii(),
    getGuardrails(),
    prisma.organization.findMany({
      where: company ? { id: company } : {},
      select: ORG_SELECT,
      orderBy: { alias: "asc" },
    }),
    prisma.project.findMany({
      where: company ? { orgId: company } : {},
      select: PROJECT_SELECT,
      orderBy: { alias: "asc" },
    }),
    prisma.virtualKey.findMany({
      where: keyScope(session),
      select: KEY_SELECT,
      orderBy: { keyAlias: "asc" },
    }),
  ]);
  const rows = [...orgs.map(orgRow), ...projects.map(projectRow), ...keys.map(keyRow)];
  const canManage = hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE);
  return {
    pii,
    guardrails,
    piiOverrides: rows.map((row) => piiOverrideOf(row.target, row.piiPolicy)).filter(present).sort(byAlias),
    guardrailOverrides: rows
      .map((row) => guardrailOverrideOf(row.target, row.guardrailPolicy))
      .filter(present)
      .sort(byAlias),
    targets: canManage ? rows.map((row) => row.target) : [],
    canManage,
    platform: !company,
  };
}

async function findTarget(session: Session, scope: PolicyScope, id: string): Promise<TargetRow | null> {
  if (scope === "org") {
    const row = await prisma.organization.findUnique({ where: { id }, select: ORG_SELECT });
    return row && inCompany(session, row.id) ? orgRow(row) : null;
  }
  if (scope === "project") {
    const row = await prisma.project.findUnique({ where: { id }, select: PROJECT_SELECT });
    return row && inCompany(session, row.orgId) ? projectRow(row) : null;
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

export async function loadGuardrails() {
  const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
  return payload(session);
}

function piiSummary(policy: PiiPolicy): PiiSummary {
  return { enabled: policy.enabled, mode: policy.mode, output: policy.output, entities: policy.entities.length };
}

function guardrailSummary(policy: GuardrailPolicy): GuardrailSummary {
  return {
    injection: policy.injection.enabled ? policy.injection.action : null,
    secrets: policy.secrets.enabled ? policy.secrets.action : null,
    rules: policy.rules.length,
  };
}

function overrideSummary(row: TargetRow): PolicyOverrideSummary | null {
  const pii = piiOverride(row.piiPolicy);
  const guardrails = guardrailOverride(row.guardrailPolicy);
  if (!pii && !guardrails) return null;
  return {
    ...row.target,
    pii: pii ? piiSummary(pii) : null,
    guardrails: guardrails ? guardrailSummary(guardrails) : null,
  };
}

export async function loadCompanyPolicies(orgId: string): Promise<CompanyPolicies> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
  const id = typeof orgId === "string" ? orgId.trim() : "";
  if (!id) throw new Error("MISSING_ID");
  if (!inCompany(session, id)) throw new Error("NOT_FOUND");
  const [pii, guardrails, org, projects, keys] = await Promise.all([
    getPii(),
    getGuardrails(),
    prisma.organization.findUnique({ where: { id }, select: ORG_SELECT }),
    prisma.project.findMany({ where: { orgId: id }, select: PROJECT_SELECT, orderBy: { alias: "asc" } }),
    prisma.virtualKey.findMany({
      where: { ...keyScope(session), orgId: id },
      select: KEY_SELECT,
      orderBy: { keyAlias: "asc" },
    }),
  ]);
  if (!org) throw new Error("NOT_FOUND");
  const orgPii = piiOverride(org.piiPolicy);
  const orgGuardrails = guardrailOverride(org.guardrailPolicy);
  return {
    pii: { level: orgPii ? "org" : "global", ...piiSummary(orgPii ?? pii) },
    guardrails: { level: orgGuardrails ? "org" : "global", ...guardrailSummary(orgGuardrails ?? guardrails) },
    overrides: [...projects.map(projectRow), ...keys.map(keyRow)].map(overrideSummary).filter(present),
  };
}

export async function savePii(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  assertPlatform(session);
  const parsed = piiPolicySchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const saved = await storePii(parsed.data);
  await writeAudit({
    actor: session.user.id,
    action: "settings.pii",
    objectType: "pii",
    objectId: "pii",
    after: saved,
  });
  return { pii: saved };
}

export async function savePiiOverride(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = piiOverrideSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const { scope, id } = parsed.data;
  const existing = await findTarget(session, scope, id);
  if (!existing) throw new Error("NOT_FOUND");
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
}

export async function saveGuardrailPolicy(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  assertPlatform(session);
  const parsed = guardrailPolicySchema.safeParse(raw);
  if (!parsed.success) throw new Error(policyFailure(parsed.error));
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
}

export async function saveGuardrailOverride(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = guardrailOverrideSchema.safeParse(raw);
  if (!parsed.success) throw new Error(policyFailure(parsed.error));
  const { scope, id } = parsed.data;
  const existing = await findTarget(session, scope, id);
  if (!existing) throw new Error("NOT_FOUND");
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
}

export async function testPii(text: string) {
  await requirePermission(PERMISSIONS.SETTINGS_READ);
  const pii = await getPii();
  if (pii.enabled === false) return { redacted: text };
  return { redacted: redactPii(text, pii.entities) };
}

export async function testGuardrails(raw: unknown) {
  await requirePermission(PERMISSIONS.SETTINGS_READ);
  const parsed = guardrailTestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(policyFailure(parsed.error));
  return evaluateGuardrails(parsed.data.text, parsed.data.policy, parsed.data.direction);
}
