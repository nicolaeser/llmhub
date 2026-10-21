import type { KeyChoices, KeyOptions, KeyPreset, VirtualKeyView } from "@/types/keys";
import type { BudgetView, KeyNode, NodeRef, StructurePayload } from "@/types/structure";

export function keyPresetOf(ref: NodeRef | null): KeyPreset | null {
  if (ref?.kind === "project" || ref?.kind === "member") return { kind: ref.kind, id: ref.id };
  return null;
}

export function keyOptionsOf(data: StructurePayload, choices: KeyChoices): KeyOptions {
  return {
    ...choices,
    companyId: data.companyId,
    orgs: data.orgs.map((row) => ({ id: row.id, alias: row.alias })),
    teams: data.teams.map((row) => ({ id: row.id, alias: row.alias, orgId: row.orgId })),
    projects: data.projects.map((row) => ({ id: row.id, alias: row.alias, orgId: row.orgId, teamId: row.teamId })),
    members: data.members.map((row) => ({ id: row.id, alias: row.alias, orgId: row.orgId, teamId: row.teamId })),
  };
}

function freshBudget(key: VirtualKeyView): BudgetView {
  return {
    maxBudget: key.max_budget,
    spend: key.spend,
    budgetDuration: key.budget_duration,
    boost: 0,
    boosts: [],
    resetsAt: null,
    projectedMonth: 0,
    daysToExhaust: null,
    pctUsed: null,
  };
}

export function keyNodeOf(key: VirtualKeyView, budget: BudgetView): KeyNode {
  return {
    id: key.token_id,
    alias: key.key_alias || key.key_name,
    prefix: key.key_name,
    userId: key.user_id,
    orgId: key.org_id,
    teamId: key.team_id,
    projectId: key.project_id,
    memberId: key.member_id,
    blocked: key.blocked,
    budget,
  };
}

export function withKey(data: StructurePayload, key: VirtualKeyView): StructurePayload {
  const current = data.keys.find((row) => row.id === key.token_id);
  const node = keyNodeOf(key, current?.budget ?? freshBudget(key));
  const keys = current
    ? data.keys.map((row) => (row.id === node.id ? node : row))
    : [...data.keys, node].sort((a, b) => a.alias.localeCompare(b.alias));
  return { ...data, keys };
}

export function withoutKey(data: StructurePayload, id: string): StructurePayload {
  return { ...data, keys: data.keys.filter((row) => row.id !== id) };
}
