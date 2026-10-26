import type { ChargebackParts, SliceRow, UsageSlice, UsageSummary } from "@/types/usage";

type SliceKey = keyof Pick<
  UsageSlice,
  "model" | "teamId" | "orgId" | "projectId" | "memberId" | "keyId" | "userId"
>;

const CHARGEBACK_PARTS = ["orgId", "teamId", "projectId", "memberId", "keyId", "userId", "model"] as const;
const SLICE_DIMENSIONS = ["day", "keyId", "teamId", "orgId", "projectId", "memberId", "userId", "model"] as const;
const LABEL_SEPARATOR = "\u001f";
const MONEY_STEPS = 1e10;

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

export const SYSTEM_SLICE = "system";
export const UNASSIGNED_SLICE = "unassigned";

export function systemSlice(row: Pick<UsageSlice, Exclude<SliceKey, "model">>): boolean {
  return !row.keyId && !row.userId && !row.memberId && !row.projectId && !row.teamId && !row.orgId;
}

function sliceName(row: UsageSlice, key: SliceKey): string {
  return row[key] || (systemSlice(row) ? SYSTEM_SLICE : UNASSIGNED_SLICE);
}

export function groupSpend(rows: UsageSlice[], key: SliceKey): SliceRow[] {
  return rollUp(rows.filter(billable), (row) => sliceName(row, key)).sort(
    (a, b) => b.spend - a.spend,
  );
}

export function groupRequestHealth(rows: UsageSlice[], key: SliceKey): SliceRow[] {
  return rollUp(rows, (row) => sliceName(row, key)).sort(
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
  return rollUp(rows.filter(billable), (row) => {
    const name = CHARGEBACK_PARTS.map((part) => row[part] || "-").join("/");
    return row.label === undefined ? name : `${name}${LABEL_SEPARATOR}${row.label}`;
  }).sort((a, b) => b.spend - a.spend);
}

export function chargebackParts(name: string): ChargebackParts {
  const cut = name.indexOf(LABEL_SEPARATOR);
  const values = (cut < 0 ? name : name.slice(0, cut)).split("/");
  const tenancy = CHARGEBACK_PARTS.length - 1;
  const parts = {} as ChargebackParts;
  CHARGEBACK_PARTS.forEach((part, index) => {
    const value = index < tenancy ? values[index] : values.slice(tenancy).join("/");
    parts[part] = value && value !== "-" ? value : "";
  });
  if (cut >= 0) parts.label = name.slice(cut + 1);
  return parts;
}

function sliceIdentity(row: UsageSlice): string {
  return SLICE_DIMENSIONS.map((dimension) => row[dimension]).join(LABEL_SEPARATOR);
}

function remaining(total: number, used: number): number {
  return Math.max(0, Math.round((total - used) * MONEY_STEPS) / MONEY_STEPS);
}

function sliceUsage(row: UsageSlice): boolean {
  return row.requests > 0 || row.cost > 0 || row.promptTokens > 0 || row.completionTokens > 0;
}

export function labelBreakdown(daily: UsageSlice[], labeled: UsageSlice[]): UsageSlice[] {
  const used = new Map<string, UsageSlice>();
  for (const row of labeled) {
    const id = sliceIdentity(row);
    const sum = used.get(id);
    used.set(
      id,
      sum
        ? {
            ...sum,
            requests: sum.requests + row.requests,
            errors: sum.errors + row.errors,
            rateLimited: sum.rateLimited + row.rateLimited,
            latencyMs: sum.latencyMs + row.latencyMs,
            promptTokens: sum.promptTokens + row.promptTokens,
            completionTokens: sum.completionTokens + row.completionTokens,
            cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
            cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
            cost: sum.cost + row.cost,
            cacheSavings: sum.cacheSavings + row.cacheSavings,
            ...(sum.purchaseCost === undefined ? {} : { purchaseCost: sum.purchaseCost + (row.purchaseCost ?? 0) }),
          }
        : row,
    );
  }
  const unlabeled = daily.flatMap((row) => {
    const sum = used.get(sliceIdentity(row));
    const rest: UsageSlice = sum
      ? {
          ...row,
          requests: remaining(row.requests, sum.requests),
          errors: remaining(row.errors, sum.errors),
          rateLimited: remaining(row.rateLimited, sum.rateLimited),
          latencyMs: remaining(row.latencyMs, sum.latencyMs),
          promptTokens: remaining(row.promptTokens, sum.promptTokens),
          completionTokens: remaining(row.completionTokens, sum.completionTokens),
          cacheReadTokens: remaining(row.cacheReadTokens, sum.cacheReadTokens),
          cacheWriteTokens: remaining(row.cacheWriteTokens, sum.cacheWriteTokens),
          cost: remaining(row.cost, sum.cost),
          cacheSavings: remaining(row.cacheSavings, sum.cacheSavings),
          ...(row.purchaseCost === undefined ? {} : { purchaseCost: remaining(row.purchaseCost, sum.purchaseCost ?? 0) }),
        }
      : row;
    return sliceUsage(rest) ? [{ ...rest, label: "" }] : [];
  });
  return [...labeled, ...unlabeled];
}

export function groupByLabel(rows: UsageSlice[]): SliceRow[] {
  return rollUp(rows, (row) => row.label ?? "").sort(
    (a, b) => b.spend - a.spend || (b.requests ?? 0) - (a.requests ?? 0),
  );
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

const LABEL_COLUMNS = ["label_key", "label_value"] as const;

export function chargebackColumns(priced: boolean, labelled = false): readonly string[] {
  const columns: readonly string[] = priced ? CHARGEBACK_MARGIN_COLUMNS : CHARGEBACK_COLUMNS;
  if (!labelled) return columns;
  const at = columns.indexOf("model") + 1;
  return [...columns.slice(0, at), ...LABEL_COLUMNS, ...columns.slice(at)];
}

export function chargebackTable(
  rows: SliceRow[],
  names: Record<string, string>,
  labelKey = "",
): (Record<(typeof CHARGEBACK_COLUMNS)[number], string | number> &
  Partial<Record<"purchase_cost" | "margin", number> & Record<(typeof LABEL_COLUMNS)[number], string>>)[] {
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
      ...(labelKey ? { label_key: labelKey, label_value: parts.label ?? "" } : {}),
      spend: row.spend,
      ...(row.purchase === undefined ? {} : { purchase_cost: row.purchase, margin: row.spend - row.purchase }),
      prompt_tokens: row.prompt,
      completion_tokens: row.completion,
    };
  });
}

export const LABEL_SUMMARY_COLUMNS = [
  "label_key",
  "label_value",
  "requests",
  "spend",
  "prompt_tokens",
  "completion_tokens",
] as const;

export function labelSummaryTable(
  groups: { key: string; rows: SliceRow[] }[],
): Record<(typeof LABEL_SUMMARY_COLUMNS)[number], string | number>[] {
  return groups.flatMap((group) =>
    group.rows.map((row) => ({
      label_key: group.key,
      label_value: row.name,
      requests: row.requests ?? 0,
      spend: row.spend,
      prompt_tokens: row.prompt,
      completion_tokens: row.completion,
    })),
  );
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
