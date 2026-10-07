import type {
  BudgetKind,
  BudgetView,
  CapLink,
  NodeKind,
  NodeRef,
  StructurePayload,
} from "@/types/structure";

const NODE_KINDS: readonly NodeKind[] = ["org", "team", "project", "member"];

export function isNodeKind(value: string): value is NodeKind {
  return NODE_KINDS.some((kind) => kind === value);
}

export function parseNodeRef(value: string | null | undefined): NodeRef | null {
  const [kind, id] = (value ?? "").split(":");
  if (!id || !kind || !isNodeKind(kind)) return null;
  return { kind, id };
}

function rowsOf(data: StructurePayload, kind: BudgetKind): { id: string; alias: string; budget: BudgetView }[] {
  if (kind === "org") return data.orgs;
  if (kind === "team") return data.teams;
  if (kind === "project") return data.projects;
  if (kind === "member") return data.members;
  if (kind === "user") return data.users;
  return data.keys;
}

export function nodeExists(data: StructurePayload, ref: NodeRef | null): boolean {
  return Boolean(ref && rowsOf(data, ref.kind).some((row) => row.id === ref.id));
}

export function nodeAlias(data: StructurePayload, kind: BudgetKind, id: string): string {
  return rowsOf(data, kind).find((row) => row.id === id)?.alias ?? "";
}

function link(data: StructurePayload, kind: BudgetKind, id: string): CapLink[] {
  const row = id ? rowsOf(data, kind).find((item) => item.id === id) : undefined;
  if (!row) return [];
  return [
    {
      kind,
      id: row.id,
      alias: row.alias,
      cap: row.budget.maxBudget,
      boost: row.budget.boost,
      spend: row.budget.spend,
    },
  ];
}

function placeLinks(data: StructurePayload, teamId: string, orgId: string): CapLink[] {
  return [...link(data, "team", teamId), ...link(data, "org", orgId)];
}

export function chainOf(data: StructurePayload, kind: BudgetKind, id: string): CapLink[] {
  if (kind === "org") return link(data, "org", id);
  if (kind === "team") {
    const team = data.teams.find((row) => row.id === id);
    return team ? [...link(data, "team", id), ...link(data, "org", team.orgId)] : [];
  }
  if (kind === "project" || kind === "member") {
    const row = (kind === "project" ? data.projects : data.members).find((item) => item.id === id);
    return row ? [...link(data, kind, id), ...placeLinks(data, row.teamId, row.orgId)] : [];
  }
  if (kind === "user") {
    const user = data.users.find((row) => row.id === id);
    return user ? [...link(data, "user", id), ...link(data, "org", user.orgId)] : [];
  }
  const key = data.keys.find((row) => row.id === id);
  if (!key) return [];
  const owner = key.memberId ? data.members.find((row) => row.id === key.memberId) : undefined;
  const project = key.projectId ? data.projects.find((row) => row.id === key.projectId) : undefined;
  const internal = !key.memberId && !key.projectId;
  const user = internal ? data.users.find((row) => row.id === key.userId) : undefined;
  const place = owner ?? project;
  return [
    ...link(data, "key", id),
    ...(user ? [...link(data, "user", user.id), ...link(data, "org", user.orgId)] : []),
    ...(owner ? link(data, "member", owner.id) : []),
    ...(project ? link(data, "project", project.id) : []),
    ...(place ? placeLinks(data, place.teamId, place.orgId) : []),
  ];
}

export function budgetOf(data: StructurePayload, kind: BudgetKind, id: string): BudgetView | null {
  return rowsOf(data, kind).find((row) => row.id === id)?.budget ?? null;
}

export function withBudget(
  data: StructurePayload,
  kind: BudgetKind,
  id: string,
  budget: BudgetView,
): StructurePayload {
  const patch = <T extends { id: string; budget: BudgetView }>(rows: T[]) =>
    rows.map((row) => (row.id === id ? { ...row, budget } : row));
  if (kind === "org") return { ...data, orgs: patch(data.orgs) };
  if (kind === "team") return { ...data, teams: patch(data.teams) };
  if (kind === "project") return { ...data, projects: patch(data.projects) };
  if (kind === "member") return { ...data, members: patch(data.members) };
  if (kind === "user") return { ...data, users: patch(data.users) };
  return { ...data, keys: patch(data.keys) };
}

export function usedRatio(budget: BudgetView): number | null {
  const cap = budget.maxBudget > 0 ? budget.maxBudget + budget.boost : 0;
  return cap > 0 ? Math.min(1, budget.spend / cap) : null;
}
