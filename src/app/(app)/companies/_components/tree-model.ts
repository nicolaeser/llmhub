import type {
  BudgetKind,
  BudgetView,
  CapLink,
  KeyNode,
  MemberNode,
  NodeKind,
  NodeLink,
  NodeRef,
  ProjectNode,
  SetupStep,
  StructurePayload,
  TreeRow,
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

function rowsOf(data: StructurePayload, kind: BudgetKind): { id: string; alias: string; budget: BudgetView }[] {
  if (kind === "org") return data.orgs;
  if (kind === "team") return data.teams;
  if (kind === "project") return data.projects;
  if (kind === "member") return data.members;
  if (kind === "user") return data.users;
  return data.keys;
}

function step(data: StructurePayload, kind: NodeKind, id: string): NodeLink[] {
  const row = id ? rowsOf(data, kind).find((item) => item.id === id) : undefined;
  return row ? [{ kind, id: row.id, alias: row.alias }] : [];
}

function placeOfKey(data: StructurePayload, key: KeyNode): { kind: "project" | "member"; row: ProjectNode | MemberNode } | null {
  const project = key.projectId ? data.projects.find((row) => row.id === key.projectId) : undefined;
  if (project) return { kind: "project", row: project };
  const member = key.memberId ? data.members.find((row) => row.id === key.memberId) : undefined;
  return member ? { kind: "member", row: member } : null;
}

export function nodePath(data: StructurePayload, ref: NodeRef | null): NodeLink[] {
  if (!ref) return [];
  if (ref.kind === "org") return step(data, "org", ref.id);
  if (ref.kind === "team") {
    const team = data.teams.find((row) => row.id === ref.id);
    return team ? [...step(data, "org", team.orgId), ...step(data, "team", team.id)] : [];
  }
  if (ref.kind === "project" || ref.kind === "member") {
    const row = (ref.kind === "project" ? data.projects : data.members).find((item) => item.id === ref.id);
    return row
      ? [...step(data, "org", row.orgId), ...step(data, "team", row.teamId), ...step(data, ref.kind, row.id)]
      : [];
  }
  const key = data.keys.find((row) => row.id === ref.id);
  if (!key) return [];
  const place = placeOfKey(data, key);
  return [
    ...step(data, "org", place?.row.orgId ?? key.orgId),
    ...step(data, "team", place ? place.row.teamId : key.teamId),
    ...(place ? step(data, place.kind, place.row.id) : []),
    ...step(data, "key", key.id),
  ];
}

export function nodeExists(data: StructurePayload, ref: NodeRef | null): boolean {
  if (!ref) return false;
  const path = nodePath(data, ref);
  const self = path.at(-1);
  if (!self || self.kind !== ref.kind || self.id !== ref.id) return false;
  return ref.kind !== "key" || path[0]?.kind === "org";
}

export function parentOf(data: StructurePayload, ref: NodeRef): NodeRef | null {
  const path = nodePath(data, ref);
  const parent = path.at(-2);
  return parent ? { kind: parent.kind, id: parent.id } : null;
}

function matches(text: string, query: string) {
  return !query || text.toLowerCase().includes(query);
}

export function treeRows(data: StructurePayload, query: string): TreeRow[] {
  const q = query.trim().toLowerCase();
  const teamIds = new Set(data.teams.map((row) => row.id));
  const row = (kind: NodeKind, item: { id: string; alias: string; budget: BudgetView }, depth: number): TreeRow => ({
    kind,
    id: item.id,
    alias: item.alias,
    budget: item.budget,
    depth,
  });
  const keyRows = (pick: (key: KeyNode) => boolean, depth: number) =>
    q
      ? data.keys
          .filter((key) => pick(key) && (matches(key.alias, q) || matches(key.prefix, q)))
          .map((key) => row("key", key, depth))
      : [];
  const branch = (kind: NodeKind, item: { id: string; alias: string; budget: BudgetView }, depth: number, children: TreeRow[]) =>
    matches(item.alias, q) || children.length ? [row(kind, item, depth), ...children] : [];
  const project = (item: ProjectNode, depth: number) =>
    branch("project", item, depth, keyRows((key) => key.projectId === item.id, depth + 1));
  const member = (item: MemberNode, depth: number) =>
    q ? branch("member", item, depth, keyRows((key) => key.memberId === item.id, depth + 1)) : [];
  const placedIn = <T extends { orgId: string; teamId: string }>(rows: T[], orgId: string, teamId: string | null) =>
    rows.filter((item) => (teamId === null ? item.orgId === orgId && !teamIds.has(item.teamId) : item.teamId === teamId));
  return data.orgs.flatMap((org) =>
    branch("org", org, 0, [
      ...data.teams
        .filter((team) => team.orgId === org.id)
        .flatMap((team) =>
          branch("team", team, 1, [
            ...placedIn(data.projects, org.id, team.id).flatMap((item) => project(item, 2)),
            ...placedIn(data.members, org.id, team.id).flatMap((item) => member(item, 2)),
          ]),
        ),
      ...placedIn(data.projects, org.id, null).flatMap((item) => project(item, 1)),
      ...placedIn(data.members, org.id, null).flatMap((item) => member(item, 1)),
      ...keyRows((key) => !key.projectId && !key.memberId && key.orgId === org.id, 1),
    ]),
  );
}

export function treeHighlight(
  data: StructurePayload,
  ref: NodeRef | null,
  rows: readonly TreeRow[],
): { key: string; exact: boolean } | null {
  if (!ref) return null;
  const shown = new Set(rows.map(nodeKey));
  const hit = nodePath(data, ref)
    .reverse()
    .find((link) => shown.has(nodeKey(link)));
  return hit ? { key: nodeKey(hit), exact: hit.kind === ref.kind && hit.id === ref.id } : null;
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
