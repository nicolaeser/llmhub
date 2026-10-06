import "server-only";

import prisma from "@/lib/db/prisma";
import {
  addBoostAction,
  deleteNodeAction,
  loadStructureAction,
  placeMemberAction,
  removeBoostAction,
  saveBudgetAlertsAction,
  saveOrgAction,
  saveProjectAction,
  saveTeamAction,
  setBudgetAction,
} from "@/app/(app)/structure/_action";
import {
  boostToolInput,
  budgetAlertsToolInput,
  deleteNodeToolInput,
  placeMemberToolInput,
  removeBoostToolInput,
  saveNodeToolInput,
  setBudgetToolInput,
  structureToolInput,
} from "@/schemas/assistant";
import { defineTool, needsConfirmation, toolFail, viaAction } from "@/lib/assistant/tools/define";
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
      teamId: row.teamId,
      owner: row.owner,
      budget: budget(row.budget),
    })),
    users: payload.users.map((row) => ({
      id: row.id,
      username: row.username,
      orgId: row.orgId,
      teamId: row.teamId,
      blocked: row.blocked,
      budget: budget(row.budget),
    })),
    keys: payload.keys.map((row) => ({
      id: row.id,
      alias: row.alias,
      prefix: row.prefix,
      userId: row.userId,
      teamId: row.teamId,
      projectId: row.projectId,
      blocked: row.blocked,
      budget: budget(row.budget),
    })),
  };
}

const KIND_FIELD = {
  org: "orgs",
  team: "teams",
  project: "projects",
  user: "users",
  key: "keys",
} as const;

function savedNode(kind: NodeKind, alias: string, parentId: string) {
  return (payload: StructurePayload): AssistantToolResult => {
    const compact = compactStructure(payload);
    const node =
      kind === "org"
        ? compact.orgs.find((row) => row.alias === alias)
        : kind === "team"
          ? compact.teams.find((row) => row.alias === alias && row.orgId === parentId)
          : compact.projects.find((row) => row.alias === alias && row.teamId === parentId);
    return { result: { ok: true, kind, node: node ?? null }, navigate: "/structure" };
  };
}

async function saveNode(args: z.output<typeof saveNodeToolInput>): Promise<AssistantToolResult> {
  const id = args.id ?? "";
  if (args.kind === "org") {
    const existing = id ? await prisma.organization.findUnique({ where: { id } }) : null;
    if (id && !existing) return toolFail("not_found");
    const alias = args.alias ?? existing?.alias ?? "";
    return viaAction(saveOrgAction({ id, alias }), savedNode("org", alias, ""));
  }
  if (args.kind === "team") {
    const existing = id ? await prisma.team.findUnique({ where: { id } }) : null;
    if (id && !existing) return toolFail("not_found");
    const alias = args.alias ?? existing?.alias ?? "";
    const orgId = args.orgId ?? existing?.orgId ?? "";
    return viaAction(
      saveTeamAction({
        id,
        alias,
        orgId,
        rpm: args.rpm ?? existing?.rpmLimit ?? 0,
        tpm: args.tpm ?? existing?.tpmLimit ?? 0,
      }),
      savedNode("team", alias, orgId),
    );
  }
  const existing = id ? await prisma.project.findUnique({ where: { id } }) : null;
  if (id && !existing) return toolFail("not_found");
  const alias = args.alias ?? existing?.alias ?? "";
  const teamId = args.teamId ?? existing?.teamId ?? "";
  return viaAction(
    saveProjectAction({ id, alias, teamId, owner: args.owner ?? existing?.owner ?? "" }),
    savedNode("project", alias, teamId),
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
      "Organizations, teams (with RPM and TPM limits), projects, users, and keys with their ids, parents, and budgets (cap, spend, period, boosts, percent used, forecast). Pass kind to keep the answer short.",
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
      "Create or update an organization, team, or project. Teams need an organization, projects need a team. Omitted fields keep their current value on update.",
    input: saveNodeToolInput,
    run: async (args) => saveNode(args),
  }),
  delete_structure_node: defineTool({
    description:
      "Delete an organization, team, or project. Organizations and teams must have no teams or projects left. Destructive: ask first and pass confirm only after the operator agreed.",
    input: deleteNodeToolInput,
    run: async ({ kind, id, confirm }) =>
      needsConfirmation(confirm) ??
      viaAction(deleteNodeAction({ kind, id }), () => ({ result: { ok: true, kind, id }, navigate: "/structure" })),
  }),
  place_member: defineTool({
    description: "Move a user into a team (which also sets the organization), into an organization only, or out of both.",
    input: placeMemberToolInput,
    run: async ({ userId, teamId, orgId }) =>
      viaAction(placeMemberAction({ userId, teamId, orgId }), (payload) => {
        const user = payload.users.find((row) => row.id === userId);
        return {
          result: { ok: true, userId, teamId: user?.teamId ?? teamId, orgId: user?.orgId ?? orgId },
          navigate: "/structure",
        };
      }),
  }),
  set_budget: defineTool({
    description:
      "Set the spend cap and reset period of an organization, team, project, user, or key. A cap cannot exceed a capped parent.",
    input: setBudgetToolInput,
    run: async (args) => budgetSaved(setBudgetAction(args)),
  }),
  add_budget_boost: defineTool({
    description: "Add a temporary budget boost on a capped organization, team, project, user, or key for up to 720 hours.",
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
