import { billingModeOf, type BillingMode } from "./deployment-draft";

export type SummaryRoute = { providerId: string | null; kind: string; model: string };

export type GroupSummaryInput = {
  deployments: readonly SummaryRoute[];
  strategy: string;
  fallbackGroups: readonly string[];
  overflowGroup: string;
  billingMode: string;
};

export type GroupSpread = "none" | "single" | "several";

export type GroupSummary = {
  spread: GroupSpread;
  endpoints: number;
  targets: string[];
  strategy: string;
  fallbacks: string[];
  overflow: string;
  billing: BillingMode;
};

export const DEFAULT_STRATEGY = "least_inflight";

export function groupSummary(group: GroupSummaryInput, nameOf: (route: SummaryRoute) => string): GroupSummary {
  const routes = group.deployments.filter((route) => route.model.trim());
  const targets = [...new Set(routes.map(nameOf).filter(Boolean))];
  return {
    spread: routes.length === 0 ? "none" : routes.length === 1 ? "single" : "several",
    endpoints: routes.length,
    targets,
    strategy: group.strategy || DEFAULT_STRATEGY,
    fallbacks: [...new Set(group.fallbackGroups.map((alias) => alias.trim()).filter(Boolean))],
    overflow: group.overflowGroup.trim(),
    billing: billingModeOf(group.billingMode),
  };
}

export function groupMatches(
  group: { alias: string; vendor: string; displayName: string },
  targets: readonly string[],
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [group.alias, group.vendor, group.displayName, ...targets].some((value) =>
    value?.toLowerCase().includes(needle),
  );
}
