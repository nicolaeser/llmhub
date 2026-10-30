import type { UsageQuery } from "@/types/usage";
import type {
  BudgetKind,
  BudgetView,
  CapLink,
  ConsoleUserNode,
  DepartmentGroup,
  KeyNode,
  MemberNode,
  NodeKind,
  NodeRef,
  SetupStep,
  StructurePayload,
  TenancyKind,
} from "@/types/structure";

const NODE_KINDS: readonly NodeKind[] = ["org", "team", "project", "member", "key"];

const SETUP_STEPS: readonly SetupStep[] = ["org", "team", "project", "member", "budget"];

export function setupStepsFor(input: { company: boolean; canBudget: boolean }): SetupStep[] {
  return SETUP_STEPS.filter(
    (step) => !(step === "org" && input.company) && !(step === "budget" && !input.canBudget),
  );
}

export function isNodeKind(value: string): value is NodeKind {
  return NODE_KINDS.some((kind) => kind === value);
}

export function parseNodeRef(value: string | null | undefined): NodeRef | null {
  const [kind, id] = (value ?? "").split(":");
  if (!id || !kind || !isNodeKind(kind)) return null;
  return { kind, id };
}

export function nodeKey(ref: NodeRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function usageFilterOf(ref: NodeRef, platform: boolean): Partial<UsageQuery> {
  if (ref.kind === "org") return platform ? { orgId: ref.id } : {};
  if (ref.kind === "team") return { teamId: ref.id };
  if (ref.kind === "project") return { projectId: ref.id };
  if (ref.kind === "member") return { memberId: ref.id };
  return { keyId: ref.id };
}

export function accessUsersOf(data: StructurePayload, orgId: string): ConsoleUserNode[] | null {
  if (!data.canSeeUsers || data.companyId) return null;
  return data.users.filter((user) => user.orgId === orgId);
}

function rowsOf(data: StructurePayload, kind: BudgetKind): { id: string; alias: string; budget: BudgetView }[] {
  if (kind === "org") return data.orgs;
  if (kind === "team") return data.teams;
  if (kind === "project") return data.projects;
  if (kind === "member") return data.members;
  if (kind === "user") return data.users;
  return data.keys;
}

export type NodeAction = "edit" | "budget" | "boost" | "addProject" | "createKey" | "usage" | "delete";

export type NodeFlags = { canManage: boolean; canBudget: boolean; canCreateKeys: boolean; canSeeUsage: boolean };

export function nodeActions(kind: Exclude<TenancyKind, "org">, flags: NodeFlags, capped: boolean): NodeAction[] {
  const actions: NodeAction[] = [];
  if (flags.canManage) actions.push("edit");
  if (flags.canBudget) actions.push("budget");
  if (flags.canBudget && capped) actions.push("boost");
  if (kind === "team" && flags.canManage) actions.push("addProject");
  if (kind !== "team" && flags.canCreateKeys) actions.push("createKey");
  if (flags.canSeeUsage) actions.push("usage");
  if (flags.canManage) actions.push("delete");
  return actions;
}

export function nodeIn(data: StructurePayload, ref: NodeRef | null): boolean {
  if (!ref || ref.kind === "org") return false;
  return rowsOf(data, ref.kind).some((row) => row.id === ref.id);
}

function matches(text: string, query: string) {
  return !query || text.toLowerCase().includes(query);
}

export function structureGroups(data: StructurePayload, query: string): DepartmentGroup[] {
  const q = query.trim().toLowerCase();
  const teamIds = new Set(data.teams.map((row) => row.id));
  const projectsOf = (teamId: string | null) =>
    data.projects.filter((row) => (teamId === null ? !teamIds.has(row.teamId) : row.teamId === teamId));
  const membersOf = (teamId: string) => data.members.filter((row) => row.teamId === teamId).length;
  const groups: DepartmentGroup[] = data.teams.map((team) => ({
    team,
    projects: projectsOf(team.id),
    members: membersOf(team.id),
  }));
  const loose = projectsOf(null);
  const all = loose.length ? [...groups, { team: null, projects: loose, members: 0 }] : groups;
  if (!q) return all;
  return all.flatMap((group) => {
    if (group.team && matches(group.team.alias, q)) return [group];
    const projects = group.projects.filter((row) => matches(row.alias, q) || matches(row.owner, q));
    return projects.length ? [{ ...group, projects }] : [];
  });
}

export function matchesMember(member: MemberNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  return matches(member.alias, q) || matches(member.email, q);
}

export function matchesKey(key: KeyNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  return matches(key.alias, q) || matches(key.prefix, q);
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

