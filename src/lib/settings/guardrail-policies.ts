import "server-only";

import prisma from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { assertPlatform, companyOf, inCompany, keyScope, keyVisibleTo } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/audit";
import { testGuardrails as evaluateGuardrails } from "@/lib/gateway/safety/guardrails";
import { defaultEntityIds, redactPii } from "@/lib/gateway/safety/pii";
import {
  chainLayers,
  effectivePolicies,
  fullLayer,
  isInheritAll,
  policyChain,
  refKey,
  sectionSummaries,
} from "@/lib/gateway/safety/policy-layers";
import {
  getGuardrails,
  getPiiDetector,
  getPlatformPolicies,
  normalizePiiDetector,
  patchEnterprise,
  POLICY_OVERRIDE_SELECT,
  policyLayer,
  policyRefOf,
  policyWhere,
  saveGuardrails,
  savePii as storePii,
} from "@/lib/settings/enterprise";
import { assertModelRoles, featureModelChoices } from "@/lib/models/aliases";
import {
  guardrailPolicySchema,
  piiDetectorSettingsSchema,
  piiPolicySchema,
  policyOverrideSchema,
  policyRefSchema,
  policyTestSchema,
} from "@/schemas/guardrails";
import type {
  CompanyPolicies,
  PolicyLayer,
  PolicyOverrideView,
  PolicyRef,
  PolicyTarget,
  PolicyTestResult,
} from "@/types/guardrails";
import { env } from "@/lib/env";
import type { z } from "zod";

type Session = Awaited<ReturnType<typeof requirePermission>>;

type JsonColumn = Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;

const PATTERN_ISSUES = new Set(["invalid", "nested_quantifier", "matches_empty"]);

const TENANCY_SELECT = { teamId: true, orgId: true } as const;

const KEY_SELECT = {
  id: true,
  keyAlias: true,
  prefix: true,
  orgId: true,
  userId: true,
  projectId: true,
  project: { select: TENANCY_SELECT },
  member: { select: TENANCY_SELECT },
} as const;

type KeyTargetRow = {
  id: string;
  keyAlias: string;
  prefix: string;
  orgId: string | null;
  userId: string | null;
  projectId: string | null;
  project: { teamId: string | null; orgId: string | null } | null;
  member: { teamId: string | null; orgId: string | null } | null;
};

type TargetDirectory = {
  targets: PolicyTarget[];
  find: (ref: PolicyRef) => PolicyTarget | undefined;
};

function policyFailure(error: z.ZodError): string {
  if (error.issues.some((issue) => PATTERN_ISSUES.has(issue.message))) return "INVALID_PATTERN";
  if (error.issues.some((issue) => issue.message === "duplicate")) return "NAME_EXISTS";
  return "VALIDATION";
}

function names(rows: readonly { id: string; alias: string }[]): Map<string, string> {
  return new Map(rows.map((row) => [row.id, row.alias]));
}

function pathOf(...aliases: (string | undefined)[]): string[] {
  return aliases.filter((alias): alias is string => Boolean(alias));
}

function keyTenancy(row: KeyTargetRow) {
  const owner = row.project ?? row.member;
  return {
    orgId: owner?.orgId ?? row.orgId ?? "",
    teamId: owner?.teamId ?? "",
    projectId: row.projectId ?? "",
  };
}

async function loadDirectory(session: Session): Promise<TargetDirectory> {
  const company = companyOf(session);
  const tenancy = company ? { orgId: company } : {};
  const [orgs, teams, projects, keys] = await Promise.all([
    prisma.organization.findMany({
      where: company ? { id: company } : {},
      select: { id: true, alias: true },
      orderBy: { alias: "asc" },
    }),
    prisma.team.findMany({ where: tenancy, select: { id: true, alias: true, orgId: true }, orderBy: { alias: "asc" } }),
    prisma.project.findMany({
      where: tenancy,
      select: { id: true, alias: true, orgId: true, teamId: true },
      orderBy: { alias: "asc" },
    }),
    prisma.virtualKey.findMany({ where: keyScope(session), select: KEY_SELECT, orderBy: { keyAlias: "asc" } }),
  ]);
  const orgNames = names(orgs);
  const teamNames = names(teams);
  const projectNames = names(projects);
  const targets: PolicyTarget[] = [
    ...orgs.map((row) => ({
      scope: "org" as const,
      id: row.id,
      alias: row.alias,
      orgId: row.id,
      teamId: "",
      projectId: "",
      path: [],
    })),
    ...teams.map((row) => ({
      scope: "team" as const,
      id: row.id,
      alias: row.alias,
      orgId: row.orgId ?? "",
      teamId: row.id,
      projectId: "",
      path: pathOf(orgNames.get(row.orgId ?? "")),
    })),
    ...projects.map((row) => ({
      scope: "project" as const,
      id: row.id,
      alias: row.alias,
      orgId: row.orgId ?? "",
      teamId: row.teamId ?? "",
      projectId: row.id,
      path: pathOf(orgNames.get(row.orgId ?? ""), teamNames.get(row.teamId ?? "")),
    })),
    ...keys.map((row) => {
      const owner = keyTenancy(row);
      return {
        scope: "key" as const,
        id: row.id,
        alias: row.keyAlias || row.prefix,
        ...owner,
        path: pathOf(orgNames.get(owner.orgId), teamNames.get(owner.teamId), projectNames.get(owner.projectId)),
      };
    }),
  ];
  const byRef = new Map(targets.map((target) => [refKey(target), target]));
  return { targets, find: (ref) => byRef.get(refKey(ref)) };
}

function overrideView(target: PolicyTarget, layer: PolicyLayer, updatedAt: Date): PolicyOverrideView {
  return { target, ...layer, updatedAt: updatedAt.toISOString() };
}

async function loadOverrides(session: Session, directory: TargetDirectory): Promise<PolicyOverrideView[]> {
  const company = companyOf(session);
  const rows = await prisma.policyOverride.findMany({
    where: company
      ? {
          OR: [
            { orgId: company },
            { team: { orgId: company } },
            { project: { orgId: company } },
            { key: { orgId: company } },
          ],
        }
      : {},
    select: { ...POLICY_OVERRIDE_SELECT, updatedAt: true },
  });
  return rows.flatMap((row) => {
    const ref = policyRefOf(row);
    const target = ref ? directory.find(ref) : undefined;
    return target ? [overrideView(target, policyLayer(row), row.updatedAt)] : [];
  });
}

function referencedTargets(directory: TargetDirectory, overrides: readonly PolicyOverrideView[]): PolicyTarget[] {
  const keep = new Set(overrides.flatMap((row) => policyChain(row.target).map(refKey)));
  return directory.targets.filter((target) => keep.has(refKey(target)));
}

async function payload(session: Session) {
  const company = companyOf(session);
  const canManage = hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE);
  const [platform, detector, models, directory] = await Promise.all([
    getPlatformPolicies(),
    getPiiDetector(),
    company ? [] : featureModelChoices(),
    loadDirectory(session),
  ]);
  const overrides = await loadOverrides(session, directory);
  return {
    pii: platform.pii,
    guardrails: platform.guardrails,
    detector: company ? null : detector,
    models,
    redactorConfigured: !company && Boolean(env.LLMHUB_REDACTOR_URL),
    overrides,
    targets: canManage ? directory.targets : referencedTargets(directory, overrides),
    canManage,
    platform: !company,
  };
}

export async function loadGuardrails() {
  const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
  return payload(session);
}

async function findTarget(session: Session, ref: PolicyRef): Promise<PolicyTarget | null> {
  if (ref.scope === "org") {
    const row = await prisma.organization.findUnique({ where: { id: ref.id }, select: { id: true, alias: true } });
    if (!row || !inCompany(session, row.id)) return null;
    return { scope: "org", id: row.id, alias: row.alias, orgId: row.id, teamId: "", projectId: "", path: [] };
  }
  if (ref.scope === "team") {
    const row = await prisma.team.findUnique({
      where: { id: ref.id },
      select: { id: true, alias: true, orgId: true, org: { select: { alias: true } } },
    });
    if (!row || !inCompany(session, row.orgId)) return null;
    return {
      scope: "team",
      id: row.id,
      alias: row.alias,
      orgId: row.orgId ?? "",
      teamId: row.id,
      projectId: "",
      path: pathOf(row.org?.alias),
    };
  }
  if (ref.scope === "project") {
    const row = await prisma.project.findUnique({
      where: { id: ref.id },
      select: {
        id: true,
        alias: true,
        orgId: true,
        teamId: true,
        org: { select: { alias: true } },
        team: { select: { alias: true } },
      },
    });
    if (!row || !inCompany(session, row.orgId)) return null;
    return {
      scope: "project",
      id: row.id,
      alias: row.alias,
      orgId: row.orgId ?? "",
      teamId: row.teamId ?? "",
      projectId: row.id,
      path: pathOf(row.org?.alias, row.team?.alias),
    };
  }
  const row = await prisma.virtualKey.findUnique({ where: { id: ref.id }, select: KEY_SELECT });
  if (!row || !keyVisibleTo(session, row)) return null;
  const owner = keyTenancy(row);
  const parents = await Promise.all([
    owner.orgId ? prisma.organization.findUnique({ where: { id: owner.orgId }, select: { alias: true } }) : null,
    owner.teamId ? prisma.team.findUnique({ where: { id: owner.teamId }, select: { alias: true } }) : null,
    owner.projectId ? prisma.project.findUnique({ where: { id: owner.projectId }, select: { alias: true } }) : null,
  ]);
  return {
    scope: "key",
    id: row.id,
    alias: row.keyAlias || row.prefix,
    ...owner,
    path: pathOf(...parents.map((parent) => parent?.alias)),
  };
}

async function clearOverride(ref: PolicyRef): Promise<null> {
  await prisma.policyOverride.deleteMany({ where: policyWhere(ref) });
  return null;
}

function jsonColumn(value: unknown): JsonColumn {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

export async function loadCompanyPolicies(orgId: string): Promise<CompanyPolicies> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
  const id = typeof orgId === "string" ? orgId.trim() : "";
  if (!id) throw new Error("MISSING_ID");
  if (!inCompany(session, id)) throw new Error("NOT_FOUND");
  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
  if (!org) throw new Error("NOT_FOUND");
  const [platform, rows, teams, projects, keys] = await Promise.all([
    getPlatformPolicies(),
    prisma.policyOverride.findMany({
      where: { OR: [{ orgId: id }, { team: { orgId: id } }, { project: { orgId: id } }, { key: { orgId: id } }] },
      select: POLICY_OVERRIDE_SELECT,
    }),
    prisma.team.findMany({ where: { orgId: id }, select: { id: true, alias: true }, orderBy: { alias: "asc" } }),
    prisma.project.findMany({ where: { orgId: id }, select: { id: true, alias: true }, orderBy: { alias: "asc" } }),
    prisma.virtualKey.findMany({
      where: { ...keyScope(session), orgId: id },
      select: { id: true, keyAlias: true, prefix: true },
      orderBy: { keyAlias: "asc" },
    }),
  ]);
  const layers = new Map(
    rows.flatMap((row) => {
      const ref = policyRefOf(row);
      return ref ? [[refKey(ref), policyLayer(row)] as const] : [];
    }),
  );
  const orgRef: PolicyRef = { scope: "org", id };
  const effective = effectivePolicies(platform, chainLayers([orgRef], (ref) => layers.get(refKey(ref))));
  const members: PolicyTarget[] = [
    ...teams.map((row) => ({ scope: "team" as const, id: row.id, alias: row.alias })),
    ...projects.map((row) => ({ scope: "project" as const, id: row.id, alias: row.alias })),
    ...keys.map((row) => ({ scope: "key" as const, id: row.id, alias: row.keyAlias || row.prefix })),
  ].map((row) => ({ ...row, orgId: id, teamId: "", projectId: "", path: [] }));
  return {
    sections: sectionSummaries(fullLayer(effective)).map((row) => ({
      ...row,
      level: effective.sources[row.section] ? "org" : "global",
    })),
    overrides: members.flatMap((target) => {
      const layer = layers.get(refKey(target));
      return layer && !isInheritAll(layer) ? [{ ...target, sections: sectionSummaries(layer) }] : [];
    }),
  };
}

export async function savePii(raw: unknown, rawDetector?: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  assertPlatform(session);
  const parsed = piiPolicySchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const detectorInput = rawDetector === undefined ? null : piiDetectorSettingsSchema.safeParse(rawDetector);
  if (detectorInput && !detectorInput.success) throw new Error("VALIDATION");
  const previous = await getPiiDetector();
  const detector = detectorInput ? normalizePiiDetector(detectorInput.data) : previous;
  if (detector.model && detector.model !== previous.model) await assertModelRoles([{ alias: detector.model, role: "redaction" }]);
  const saved = await storePii(parsed.data);
  if (detectorInput) await patchEnterprise({ pii_detector: detector });
  await writeAudit({
    actor: session.user.id,
    action: "settings.pii",
    objectType: "pii",
    objectId: "pii",
    after: { ...saved, detector },
  });
  return { pii: saved, detector };
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

export async function savePolicyOverride(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = policyOverrideSchema.safeParse(raw);
  if (!parsed.success) throw new Error(policyFailure(parsed.error));
  const { scope, id, ...sections } = parsed.data;
  const ref: PolicyRef = { scope, id };
  const target = await findTarget(session, ref);
  if (!target) throw new Error("NOT_FOUND");
  const where = policyWhere(ref);
  const existing = await prisma.policyOverride.findUnique({ where, select: POLICY_OVERRIDE_SELECT });
  const layer = policyLayer(sections);
  if (!existing && isInheritAll(layer)) return { ref, override: null };
  const data = {
    pii: jsonColumn(layer.pii),
    injection: jsonColumn(layer.injection),
    secrets: jsonColumn(layer.secrets),
    rules: jsonColumn(layer.rules),
  };
  const saved = isInheritAll(layer)
    ? await clearOverride(ref)
    : await prisma.policyOverride.upsert({
        where,
        create: { ...where, ...data },
        update: data,
        select: { updatedAt: true },
      });
  await writeAudit({
    actor: session.user.id,
    action: "policy.override",
    objectType: scope,
    objectId: id,
    before: existing ? policyLayer(existing) : null,
    after: saved ? layer : null,
  });
  return { ref, override: saved ? overrideView(target, layer, saved.updatedAt) : null };
}

export async function removePolicyOverride(raw: unknown) {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = policyRefSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  return savePolicyOverride({ ...parsed.data, pii: null, injection: null, secrets: null, rules: null });
}

export async function testPolicies(raw: unknown): Promise<PolicyTestResult> {
  await requirePermission(PERMISSIONS.SETTINGS_READ);
  const parsed = policyTestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(policyFailure(parsed.error));
  const { text, direction, pii, guardrails } = parsed.data;
  const screened = evaluateGuardrails(text, guardrails, direction);
  const scanned = pii.enabled && !screened.blocked && (direction === "input" || pii.output);
  const found = new Set<string>();
  const redacted = scanned
    ? redactPii(screened.text, pii.entities.length ? pii.entities : defaultEntityIds(), found)
    : screened.text;
  const piiBlocked = direction === "input" && pii.mode === "block" && found.size > 0;
  return {
    text: redacted,
    hits: screened.hits,
    blocked: screened.blocked || piiBlocked,
    blockedBy: screened.blocked ? "guardrail" : piiBlocked ? "pii" : null,
    pii: [...found],
  };
}
