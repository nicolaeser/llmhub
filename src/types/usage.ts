import type { loadUsage } from "@/lib/usage/dashboard";

export type OkStats = Awaited<ReturnType<typeof loadUsage>>;

export type UsageQuery = {
  days: number;
  model: string;
  teamId: string;
  orgId: string;
  projectId: string;
  memberId: string;
  keyId: string;
  userId: string;
};

export type TipItem = {
  name?: unknown;
  value?: unknown;
  dataKey?: unknown;
};

export type DailyPoint = {
  day: string;
  spend: number;
  requests: number;
  errors: number;
};

export type ModelPoint = {
  name: string;
  spend: number;
  prompt: number;
  completion: number;
};

export type SpendPoint = {
  name: string;
  spend: number;
};

export type HealthPoint = {
  name: string;
  errors?: number;
  rate429?: number;
};

export type BudgetForecast = {
  dailyAvg: number;
  projectedMonth: number;
  daysToExhaust: number | null;
  pctUsed: number | null;
};

export type UsageSlice = {
  day: string;
  keyId: string;
  teamId: string;
  orgId: string;
  projectId: string;
  memberId: string;
  userId: string;
  model: string;
  requests: number;
  errors: number;
  rateLimited: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  cacheSavings: number;
  purchaseCost?: number;
};

export type ChargebackParts = {
  orgId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  keyId: string;
  userId: string;
  model: string;
};

export type SliceRow = {
  name: string;
  spend: number;
  purchase?: number;
  prompt: number;
  completion: number;
  requests?: number;
  errors?: number;
  rate429?: number;
  latency?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheSavings?: number;
};

export type UsageDay = { day: string; spend: number; requests: number; errors: number };

export type UsageSummary = {
  daily: UsageDay[];
  spend: number;
  tokens: number;
  count: number;
  errors: number;
  rate429: number;
  latency: number;
  cacheRead: number;
  cacheWrite: number;
  cacheSavings: number;
  cacheHitRate: number;
};
