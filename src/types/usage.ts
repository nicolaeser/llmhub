import type { loadUsageAction } from "@/app/(app)/_action";

type Stats = Awaited<ReturnType<typeof loadUsageAction>>;

export type OkStats = Exclude<Stats, { ok: false }>;

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
