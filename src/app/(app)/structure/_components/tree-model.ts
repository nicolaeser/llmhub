import type {
  BudgetKind,
  BudgetView,
  CapLink,
  NodeRef,
  StructurePayload,
} from "@/types/structure";

export function parseNodeRef(value: string | null | undefined): NodeRef | null {
  const [kind, id] = (value ?? "").split(":");
  if (!id || (kind !== "org" && kind !== "team" && kind !== "project")) return null;
  return { kind, id };
}

export function nodeExists(data: StructurePayload, ref: NodeRef | null): boolean {
  if (!ref) return false;
  if (ref.kind === "org") return data.orgs.some((row) => row.id === ref.id);
  if (ref.kind === "team") return data.teams.some((row) => row.id === ref.id);
  return data.projects.some((row) => row.id === ref.id);
}

function link(kind: BudgetKind, id: string, alias: string, budget: BudgetView): CapLink {
  return { kind, id, alias, cap: budget.maxBudget, boost: budget.boost, spend: budget.spend };
}

export function chainOf(data: StructurePayload, kind: BudgetKind, id: string): CapLink[] {
  const orgLink = (orgId: string) => {
    const org = data.orgs.find((row) => row.id === orgId);
    return org ? [link("org", org.id, org.alias, org.budget)] : [];
  };
  const teamLinks = (teamId: string, fallbackOrg = "") => {
    const team = data.teams.find((row) => row.id === teamId);
    if (!team) return orgLink(fallbackOrg);
    return [link("team", team.id, team.alias, team.budget), ...orgLink(team.orgId)];
  };
  if (kind === "org") {
    return orgLink(id);
  }
  if (kind === "team") {
    return teamLinks(id);
  }
  if (kind === "project") {
    const project = data.projects.find((row) => row.id === id);
    if (!project) return [];
    return [link("project", project.id, project.alias, project.budget), ...teamLinks(project.teamId)];
  }
  if (kind === "user") {
    const user = data.users.find((row) => row.id === id);
    if (!user) return [];
    return [
      link("user", user.id, user.username, user.budget),
      ...teamLinks(user.teamId, user.orgId),
    ];
  }
  const key = data.keys.find((row) => row.id === id);
  if (!key) return [];
  const owner = data.users.find((row) => row.id === key.userId);
  const project = data.projects.find((row) => row.id === key.projectId);
  const teamId = project?.teamId || key.teamId || owner?.teamId || "";
  const bound = Boolean(project?.teamId || key.teamId);
  return [
    link("key", key.id, key.alias, key.budget),
    ...(owner ? [link("user", owner.id, owner.username, owner.budget)] : []),
    ...(project ? [link("project", project.id, project.alias, project.budget)] : []),
    ...teamLinks(teamId, bound ? "" : (owner?.orgId ?? "")),
  ];
}

export function budgetOf(data: StructurePayload, kind: BudgetKind, id: string): BudgetView | null {
  const rows =
    kind === "org"
      ? data.orgs
      : kind === "team"
        ? data.teams
        : kind === "project"
          ? data.projects
          : kind === "user"
            ? data.users
            : data.keys;
  return rows.find((row) => row.id === id)?.budget ?? null;
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
  if (kind === "user") return { ...data, users: patch(data.users) };
  return { ...data, keys: patch(data.keys) };
}

export function usedRatio(budget: BudgetView): number | null {
  const cap = budget.maxBudget > 0 ? budget.maxBudget + budget.boost : 0;
  return cap > 0 ? Math.min(1, budget.spend / cap) : null;
}
