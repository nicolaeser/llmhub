import type { ConsoleScopeState } from "@/types/console";
import type {
  BudgetView,
  CompanyLink,
  CompanyRow,
  CompanyStatus,
  CompanyTab,
  NodeRef,
  StructurePayload,
} from "@/types/structure";

export const COMPANY_TABS: readonly CompanyTab[] = [
  "overview",
  "structure",
  "people",
  "keys",
  "access",
  "integrations",
  "reports",
];

export function companySlice(data: StructurePayload, orgId: string): StructurePayload | null {
  const org = data.orgs.find((row) => row.id === orgId);
  if (!org) return null;
  const inOrg = <T extends { orgId: string }>(rows: T[]) => rows.filter((row) => row.orgId === orgId);
  return {
    ...data,
    orgs: [org],
    teams: inOrg(data.teams),
    projects: inOrg(data.projects),
    members: inOrg(data.members),
    users: inOrg(data.users),
    keys: inOrg(data.keys),
    reports: data.reports.filter((row) => row.orgId === orgId),
  };
}

export function budgetRatio(budget: BudgetView): number | null {
  const cap = budget.maxBudget > 0 ? budget.maxBudget + budget.boost : 0;
  return cap > 0 ? Math.min(1, budget.spend / cap) : null;
}

export function companyStatus(row: CompanyRow): CompanyStatus {
  const ratio = budgetRatio(row.budget);
  if (ratio !== null && ratio >= 1) return "exhausted";
  if (ratio !== null && ratio >= 0.8) return "near";
  if (!row.projects && !row.members) return "empty";
  return "ok";
}

export function matchesCompany(row: CompanyRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || row.alias.toLowerCase().includes(q);
}

export function companyTabOf(ref: NodeRef | null): CompanyTab | null {
  if (ref?.kind === "team" || ref?.kind === "project") return "structure";
  if (ref?.kind === "member") return "people";
  if (ref?.kind === "key") return "keys";
  return null;
}

export function companyHref(link: CompanyLink, platform: boolean): string {
  const params = new URLSearchParams();
  if (link.tab && link.tab !== "overview") params.set("tab", link.tab);
  if (link.node) params.set("node", `${link.node.kind}:${link.node.id}`);
  const query = params.toString();
  const path = platform ? `/companies/${encodeURIComponent(link.orgId)}` : "/companies";
  return query ? `${path}?${query}` : path;
}

export function legacyCompanyLink(ref: NodeRef, orgId: string): CompanyLink {
  if (ref.kind === "org" || ref.kind === "key") return { orgId, tab: null, node: null };
  return { orgId, tab: companyTabOf(ref), node: { kind: ref.kind, id: ref.id } };
}

export function companyAlias(state: ConsoleScopeState, orgId: string): string | undefined {
  const known = state.companies.find((row) => row.id === orgId)?.alias;
  if (known) return known;
  return state.scope.kind === "company" && state.scope.id === orgId ? state.scope.alias : undefined;
}
