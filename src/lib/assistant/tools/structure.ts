import "server-only";

import prisma from "@/lib/db/prisma";
import {
  addBoostAction,
  deleteNodeAction,
  loadStructureAction,
  removeBoostAction,
  saveBudgetAlertsAction,
  saveMemberAction,
  saveOrgAction,
  saveProjectAction,
  saveTeamAction,
  setBudgetAction,
} from "@/app/(app)/companies/_action";
import {
  boostToolInput,
  budgetAlertsToolInput,
  deleteNodeToolInput,
  removeBoostToolInput,
  saveNodeToolInput,
  setBudgetToolInput,
  structureToolInput,
} from "@/schemas/assistant";
import { defineTool, needsConfirmation, toolFail, viaAction } from "@/lib/assistant/tools/define";
import { isActionFail } from "@/lib/http/action-result";
import type { AssistantToolResult } from "@/types/assistant";
import type { ActionFail } from "@/types/actions";
import type { BudgetResult, BudgetView, NodeKind, StructurePayload } from "@/types/structure";
import type { z } from "zod";

function budget(view: BudgetView) {
  return {
    maxBudget: view.maxBudget,
    spend: view.spend,
    period: view.budgetDuration,
    boost: view.boost,
    boosts: view.boosts,
    resetsAt: view.resetsAt,
    pctUsed: view.pctUsed,
    projectedMonth: view.projectedMonth,
    daysToExhaust: view.daysToExhaust,
  };
}

function compactStructure(payload: StructurePayload) {
  return {
    orgs: payload.orgs.map((row) => ({ id: row.id, alias: row.alias, budget: budget(row.budget) })),
    teams: payload.teams.map((row) => ({
      id: row.id,
      alias: row.alias,
      orgId: row.orgId,
      rpmLimit: row.rpmLimit,
      tpmLimit: row.tpmLimit,
      budget: budget(row.budget),
    })),
    projects: payload.projects.map((row) => ({
      id: row.id,
      alias: row.alias,
      orgId: row.orgId,
      teamId: row.teamId,
      owner: row.owner,
      budget: budget(row.budget),
    })),
    members: payload.members.map((row) => ({
      id: row.id,
      name: row.alias,
      orgId: row.orgId,
      teamId: row.teamId,
      blocked: row.blocked,
      logContent: row.logContent,
      budget: budget(row.budget),
    })),
    users: payload.users.map((row) => ({
      id: row.id,
      username: row.alias,
      orgId: row.orgId,
      budget: budget(row.budget),
    })),
    keys: payload.keys.map((row) => ({
      id: row.id,
      alias: row.alias,
      prefix: row.prefix,
      binding: row.memberId ? "member" : row.projectId ? "project" : "internal",
      orgId: row.orgId,
      teamId: row.teamId,
      projectId: row.projectId,
      memberId: row.memberId,
      userId: row.userId,
      blocked: row.blocked,
      budget: budget(row.budget),
    })),
  };
}

const KIND_FIELD = {
  org: "orgs",
  team: "teams",
  project: "projects",
  member: "members",
  user: "users",
  key: "keys",
} as const;

function idsOf(payload: StructurePayload, kind: NodeKind): string[] {
  const rows =
    kind === "org"
      ? payload.orgs
      : kind === "team"
        ? payload.teams
        : kind === "project"
          ? payload.projects
          : payload.members;
  return rows.map((row) => row.id);
}

function savedNode(kind: NodeKind, id: string, before: Set<string>) {
  return (payload: StructurePayload): AssistantToolResult => {
    const compact = compactStructure(payload);
    const nodeId = id || idsOf(payload, kind).find((row) => !before.has(row)) || "";
    const rows: { id: string }[] = compact[KIND_FIELD[kind]];
    const node = rows.find((row) => row.id === nodeId) ?? null;
    return { result: { ok: true, kind, node }, navigate: nodeId ? `/companies?node=${kind}:${nodeId}` : "/companies" };
  };
}

async function saveNode(args: z.output<typeof saveNodeToolInput>): Promise<AssistantToolResult> {
  const id = args.id ?? "";
  const current = await loadStructureAction();
  const before = new Set(isActionFail(current) ? [] : idsOf(current, args.kind));
  if (args.kind === "org") {
    const existing = id ? await prisma.organization.findUnique({ where: { id } }) : null;
    if (id && !existing) return toolFail("not_found");
    return viaAction(
      saveOrgAction({ id, alias: args.alias ?? existing?.alias ?? "" }),
      savedNode("org", id, before),
    );
  }
  if (args.kind === "team") {
    const existing = id ? await prisma.team.findUnique({ where: { id } }) : null;
    if (id && !existing) return toolFail("not_found");
    return viaAction(
      saveTeamAction({
        id,
        alias: args.alias ?? existing?.alias ?? "",
        orgId: args.orgId ?? existing?.orgId ?? "",
        rpm: args.rpm ?? existing?.rpmLimit ?? 0,
        tpm: args.tpm ?? existing?.tpmLimit ?? 0,
      }),
      savedNode("team", id, before),
    );
  }
  if (args.kind === "project") {
    const existing = id ? await prisma.project.findUnique({ where: { id } }) : null;
    if (id && !existing) return toolFail("not_found");
    return viaAction(
      saveProjectAction({
        id,
        alias: args.alias ?? existing?.alias ?? "",
        orgId: args.orgId ?? existing?.orgId ?? "",
        teamId: args.teamId ?? existing?.teamId ?? "",
        owner: args.owner ?? existing?.owner ?? "",
      }),
      savedNode("project", id, before),
    );
  }
  const existing = id ? await prisma.member.findUnique({ where: { id } }) : null;
  if (id && !existing) return toolFail("not_found");
  return viaAction(
    saveMemberAction({
      id,
      alias: args.alias ?? existing?.name ?? "",
      email: args.email ?? existing?.email ?? "",
      orgId: args.orgId ?? existing?.orgId ?? "",
      teamId: args.teamId ?? existing?.teamId ?? "",
      blocked: args.blocked ?? existing?.blocked ?? false,
      logContent: args.logContent ?? existing?.logContent ?? true,
    }),
    savedNode("member", id, before),
  );
}

function budgetSaved(pending: Promise<BudgetResult | ActionFail>) {
  return viaAction(pending, (saved) => ({
    result: { ok: true, kind: saved.kind, id: saved.id, budget: budget(saved.budget) },
  }));
}

export const structureTools = {
  get_structure: defineTool({
    description:
      "Customer companies (org) with their departments (team, with RPM and TPM limits), projects, people (member, the company's own users), console users, and keys with ids, parents, key binding (project, member, or internal), and budgets (cap, spend, period, boosts, percent used, forecast). Pass kind to keep the answer short.",
    input: structureToolInput,
    run: async ({ kind }) =>
      viaAction(loadStructureAction(), (payload) => {
        const compact = compactStructure(payload);
        if (!kind) return { result: { ...compact, budgetAlertThresholds: payload.thresholds } };
        return { result: { [KIND_FIELD[kind]]: compact[KIND_FIELD[kind]] } };
      }),
  }),
  save_structure_node: defineTool({
    description:
      "Create or update a company (org), department (team), project, or person (member). Departments, projects, and people need orgId when created and stay in that company; projects and people may sit in a department of the same company. Omitted fields keep their current value on update.",
    input: saveNodeToolInput,
    run: async (args) => saveNode(args),
  }),
  delete_structure_node: defineTool({
    description:
      "Delete a company, department, project, or person. A company must be empty first. Deleting a department keeps its projects and people in the company. Deleting a project or person revokes its keys. Destructive: ask first and pass confirm only after the operator agreed.",
    input: deleteNodeToolInput,
    run: async ({ kind, id, confirm }) =>
      needsConfirmation(confirm) ??
      viaAction(deleteNodeAction({ kind, id }), () => ({
        result: { ok: true, kind, id },
        navigate: "/companies",
      })),
  }),
  set_budget: defineTool({
    description:
      "Set the spend cap and reset period of a company, department, project, person, console user, or key. A cap cannot exceed a capped parent.",
    input: setBudgetToolInput,
    run: async (args) => budgetSaved(setBudgetAction(args)),
  }),
  add_budget_boost: defineTool({
    description:
      "Add a temporary budget boost on a capped company, department, project, person, console user, or key for up to 720 hours.",
    input: boostToolInput,
    run: async (args) => budgetSaved(addBoostAction(args)),
  }),
  remove_budget_boost: defineTool({
    description: "Remove a temporary budget boost by its id (from get_structure).",
    input: removeBoostToolInput,
    run: async ({ boostId }) => budgetSaved(removeBoostAction(boostId)),
  }),
  set_budget_alerts: defineTool({
    description: "Set the budget usage percentages that fire budget_threshold alert webhooks.",
    input: budgetAlertsToolInput,
    run: async ({ thresholds }) =>
      viaAction(saveBudgetAlertsAction(thresholds), (saved) => ({ result: { ok: true, thresholds: saved.thresholds } })),
  }),
};
