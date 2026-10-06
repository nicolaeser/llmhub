import type { SliceRow, UsageSlice } from "@/types/gateway";

type SliceKey = keyof Pick<UsageSlice, "model" | "teamId" | "orgId" | "projectId" | "keyId" | "userId">;

function rollUp(rows: UsageSlice[], nameOf: (row: UsageSlice) => string): SliceRow[] {
  const map = new Map<string, Required<SliceRow> & { latencySum: number }>();
  for (const row of rows) {
    const name = nameOf(row);
    const cur = map.get(name) ?? {
      name,
      spend: 0,
      prompt: 0,
      completion: 0,
      requests: 0,
      errors: 0,
      rate429: 0,
      latency: 0,
      latencySum: 0,
    };
    cur.spend += row.cost;
    cur.prompt += row.promptTokens;
    cur.completion += row.completionTokens;
    cur.requests += row.requests;
    cur.errors += row.errors;
    cur.rate429 += row.rateLimited;
    cur.latencySum += row.latencyMs;
    map.set(name, cur);
  }
  return [...map.values()].map(({ latencySum, ...row }) => ({
    ...row,
    latency: row.requests ? latencySum / row.requests : 0,
  }));
}

const billable = (row: UsageSlice) => row.cost > 0 || row.promptTokens > 0 || row.completionTokens > 0;

export function groupSpend(rows: UsageSlice[], key: SliceKey): SliceRow[] {
  return rollUp(rows.filter(billable), (row) => row[key] || "unassigned").sort(
    (a, b) => b.spend - a.spend,
  );
}

export function groupRequestHealth(rows: UsageSlice[], key: SliceKey): SliceRow[] {
  return rollUp(rows, (row) => row[key] || "unassigned").sort(
    (a, b) => (b.requests ?? 0) - (a.requests ?? 0),
  );
}

export function chargebackRows(rows: UsageSlice[]): SliceRow[] {
  return rollUp(rows.filter(billable), (row) =>
    [row.orgId, row.teamId, row.projectId, row.keyId, row.userId, row.model]
      .map((part) => part || "-")
      .join("/"),
  ).sort((a, b) => b.spend - a.spend);
}

export function percentileIndex(count: number, p: number): number {
  return Math.min(count - 1, Math.max(0, Math.ceil((p / 100) * count) - 1));
}
