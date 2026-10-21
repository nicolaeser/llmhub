import type { UsageQuery } from "@/types/usage";

export const USAGE_RANGES = [7, 14, 30, 90] as const;

export const DEFAULT_USAGE_QUERY: UsageQuery = {
  days: 14,
  model: "",
  teamId: "",
  orgId: "",
  projectId: "",
  memberId: "",
  keyId: "",
  userId: "",
};

const FILTER_KEYS = ["model", "orgId", "teamId", "projectId", "memberId", "keyId", "userId"] as const;

type UsageFilterKey = (typeof FILTER_KEYS)[number];

const MAX_FILTER_LENGTH = 200;

function filterValue(value: string | null): string {
  return (value ?? "").trim().slice(0, MAX_FILTER_LENGTH);
}

export function usageQueryFromSearch(search: string): UsageQuery {
  const params = new URLSearchParams(search);
  const days = Number(params.get("days"));
  const query: UsageQuery = {
    ...DEFAULT_USAGE_QUERY,
    days: USAGE_RANGES.find((range) => range === days) ?? DEFAULT_USAGE_QUERY.days,
  };
  for (const key of FILTER_KEYS) query[key] = filterValue(params.get(key));
  return query;
}

export function usageQueryParams(query: UsageQuery): Record<"days" | UsageFilterKey, string | null> {
  const params: Record<"days" | UsageFilterKey, string | null> = {
    days: query.days === DEFAULT_USAGE_QUERY.days ? null : String(query.days),
    model: null,
    orgId: null,
    teamId: null,
    projectId: null,
    memberId: null,
    keyId: null,
    userId: null,
  };
  for (const key of FILTER_KEYS) params[key] = query[key] || null;
  return params;
}

export function usageHref(filters: Partial<UsageQuery>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(usageQueryParams({ ...DEFAULT_USAGE_QUERY, ...filters }))) {
    if (value !== null) params.set(name, value);
  }
  const query = params.toString();
  return query ? `/usage?${query}` : "/usage";
}
