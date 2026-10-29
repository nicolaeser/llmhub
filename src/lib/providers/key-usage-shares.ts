import { limitGroups } from "@/lib/gateway/upstreams/limit-groups";
import { scopeApplies } from "@/lib/gateway/routing/quota";
import type {
  KeyUsageBasis,
  KeyUsageRow,
  KeyUsageWindow,
  LimitGroup,
  SubscriptionLimits,
  WindowKeyUsage,
  WindowUsage,
} from "@/types/providers";

const MINUTE_MS = 60_000;

type KeyTotals = { requests: number; tokens: number; cost: number };

export function windowStart(group: Pick<LimitGroup, "resetsAt" | "windowSeconds">, now: number): number | null {
  if (group.windowSeconds <= 0) return null;
  const span = group.windowSeconds * 1_000;
  const reset = group.resetsAt ? Date.parse(group.resetsAt) : NaN;
  const start = Number.isFinite(reset) && reset > now ? reset - span : now - span;
  return Math.floor(start / MINUTE_MS) * MINUTE_MS;
}

export function usageWindows(kind: string, limits: SubscriptionLimits | null, now: number): KeyUsageWindow[] {
  return limitGroups(kind, limits, now).flatMap((group) => {
    const since = windowStart(group, now);
    if (since === null) return [];
    return [{ groupId: group.id, since, scopes: group.scoped ? group.members.map((member) => member.scope) : null }];
  });
}

function basisOf(totals: KeyTotals): KeyUsageBasis {
  if (totals.cost > 0) return "cost";
  if (totals.tokens > 0) return "tokens";
  return "requests";
}

function weightOf(totals: KeyTotals, basis: KeyUsageBasis): number {
  if (basis === "cost") return totals.cost;
  if (basis === "tokens") return totals.tokens;
  return totals.requests;
}

export function windowUsage(window: KeyUsageWindow, rows: KeyUsageRow[]): WindowUsage {
  const { scopes } = window;
  const matching = scopes ? rows.filter((row) => scopes.some((scope) => scopeApplies(scope, row.upstreamModel))) : rows;
  const byKey = new Map<string, KeyTotals>();
  const total: KeyTotals = { requests: 0, tokens: 0, cost: 0 };
  for (const row of matching) {
    const current = byKey.get(row.keyId) ?? { requests: 0, tokens: 0, cost: 0 };
    current.requests += row.requests;
    current.tokens += row.tokens;
    current.cost += row.cost;
    byKey.set(row.keyId, current);
    total.requests += row.requests;
    total.tokens += row.tokens;
    total.cost += row.cost;
  }
  const basis = basisOf(total);
  const sum = weightOf(total, basis);
  const keys: WindowKeyUsage[] = [...byKey.entries()]
    .map(([keyId, totals]) => ({ keyId, share: sum > 0 ? weightOf(totals, basis) / sum : 0, ...totals }))
    .sort((a, b) => b.share - a.share || b.requests - a.requests || a.keyId.localeCompare(b.keyId));
  return {
    groupId: window.groupId,
    since: new Date(window.since).toISOString(),
    basis,
    requests: total.requests,
    keys,
  };
}
