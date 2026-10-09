import type { ChargebackParts, SliceRow, UsageSlice, UsageSummary } from "@/types/gateway";

type SliceKey = keyof Pick<
  UsageSlice,
  "model" | "teamId" | "orgId" | "projectId" | "memberId" | "keyId" | "userId"
>;

const CHARGEBACK_PARTS = ["orgId", "teamId", "projectId", "memberId", "keyId", "userId", "model"] as const;

function rollUp(rows: UsageSlice[], nameOf: (row: UsageSlice) => string): SliceRow[] {
  const map = new Map<string, Omit<Required<SliceRow>, "purchase"> & SliceRow & { latencySum: number }>();
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
      cacheRead: 0,
      cacheWrite: 0,
      cacheSavings: 0,
      latencySum: 0,
    };
    cur.spend += row.cost;
    if (row.purchaseCost !== undefined) cur.purchase = (cur.purchase ?? 0) + row.purchaseCost;
    cur.prompt += row.promptTokens;
    cur.completion += row.completionTokens;
    cur.requests += row.requests;
    cur.errors += row.errors;
    cur.rate429 += row.rateLimited;
    cur.latencySum += row.latencyMs;
    cur.cacheRead += row.cacheReadTokens;
    cur.cacheWrite += row.cacheWriteTokens;
    cur.cacheSavings += row.cacheSavings;
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

export function groupCache(rows: UsageSlice[], key: SliceKey): SliceRow[] {
  return groupSpend(rows, key)
    .filter((row) => (row.cacheRead ?? 0) > 0 || (row.cacheWrite ?? 0) > 0)
    .sort((a, b) => (b.cacheSavings ?? 0) - (a.cacheSavings ?? 0));
}

export function cacheHitRate(cacheRead: number, prompt: number): number {
  return prompt > 0 ? cacheRead / prompt : 0;
}

export function chargebackRows(rows: UsageSlice[]): SliceRow[] {
  return rollUp(rows.filter(billable), (row) =>
    CHARGEBACK_PARTS.map((part) => row[part] || "-").join("/"),
  ).sort((a, b) => b.spend - a.spend);
}

export function chargebackParts(name: string): ChargebackParts {
  const values = name.split("/");
  const parts = {} as ChargebackParts;
  CHARGEBACK_PARTS.forEach((part, index) => {
    const value = values[index];
    parts[part] = value && value !== "-" ? value : "";
  });
  return parts;
}

export const CHARGEBACK_COLUMNS = [
  "org_id",
  "org",
  "team_id",
  "team",
  "project_id",
  "project",
  "member_id",
  "member",
  "key_id",
  "user_id",
  "model",
  "spend",
  "prompt_tokens",
  "completion_tokens",
] as const;

export const CHARGEBACK_MARGIN_COLUMNS = [
  "org_id",
  "org",
  "team_id",
  "team",
  "project_id",
  "project",
  "member_id",
  "member",
  "key_id",
  "user_id",
  "model",
  "purchase_cost",
  "spend",
  "margin",
  "prompt_tokens",
  "completion_tokens",
] as const;

export function chargebackColumns(priced: boolean): readonly string[] {
  return priced ? CHARGEBACK_MARGIN_COLUMNS : CHARGEBACK_COLUMNS;
}

export function chargebackTable(
  rows: SliceRow[],
  names: Record<string, string>,
): (Record<(typeof CHARGEBACK_COLUMNS)[number], string | number> & Partial<Record<"purchase_cost" | "margin", number>>)[] {
  return rows.map((row) => {
    const parts = chargebackParts(row.name);
    return {
      org_id: parts.orgId,
      org: names[parts.orgId] ?? "",
      team_id: parts.teamId,
      team: names[parts.teamId] ?? "",
      project_id: parts.projectId,
      project: names[parts.projectId] ?? "",
      member_id: parts.memberId,
      member: names[parts.memberId] ?? "",
      key_id: parts.keyId,
      user_id: parts.userId,
      model: parts.model,
      spend: row.spend,
      ...(row.purchase === undefined ? {} : { purchase_cost: row.purchase, margin: row.spend - row.purchase }),
      prompt_tokens: row.prompt,
      completion_tokens: row.completion,
    };
  });
}

export function usageDays(start: Date, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10),
  );
}

export function summarizeUsage(rows: UsageSlice[], days: string[]): UsageSummary {
  const daily = new Map(days.map((day) => [day, { spend: 0, requests: 0, errors: 0 }]));
  const totals = {
    spend: 0,
    tokens: 0,
    prompt: 0,
    count: 0,
    errors: 0,
    rate429: 0,
    latencySum: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheSavings: 0,
  };
  for (const row of rows) {
    const bucket = daily.get(row.day);
    if (bucket) {
      bucket.spend += row.cost;
      bucket.requests += row.requests;
      bucket.errors += row.errors;
    }
    totals.spend += row.cost;
    totals.tokens += row.promptTokens + row.completionTokens;
    totals.prompt += row.promptTokens;
    totals.count += row.requests;
    totals.errors += row.errors;
    totals.rate429 += row.rateLimited;
    totals.latencySum += row.latencyMs;
    totals.cacheRead += row.cacheReadTokens;
    totals.cacheWrite += row.cacheWriteTokens;
    totals.cacheSavings += row.cacheSavings;
  }
  return {
    daily: [...daily.entries()].map(([day, value]) => ({ day, ...value })),
    spend: totals.spend,
    tokens: totals.tokens,
    count: totals.count,
    errors: totals.errors,
    rate429: totals.rate429,
    latency: totals.count ? totals.latencySum / totals.count : 0,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    cacheSavings: totals.cacheSavings,
    cacheHitRate: cacheHitRate(totals.cacheRead, totals.prompt),
  };
}

export function percentileIndex(count: number, p: number): number {
  return Math.min(count - 1, Math.max(0, Math.ceil((p / 100) * count) - 1));
}
