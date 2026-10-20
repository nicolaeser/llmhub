import type { Permission } from "@/types/auth";
import type { LimitSnapshot } from "@/types/providers";
import type { SpendScope } from "@/types/structure";

export type LiveTopic = "limits" | "requests" | "usage";

export type LiveViewer = { permissions: Permission[]; scope: SpendScope };

export type LiveFeed<State> = {
  topic: LiveTopic;
  permission: Permission;
  pollMs: number;
  minGapMs: number;
  scopeKey(scope: SpendScope): string;
  load(scope: SpendScope, previous: State | null): Promise<State>;
  full(state: State): object;
  change(previous: State, next: State): object | null;
};

export type LiveRevoked = { revoked: true };

export type LiveLimitsEvent = { at: number; full: boolean; items: LimitSnapshot[]; removed: string[] };

export type LiveLimits = { at: number; items: Record<string, LimitSnapshot>; removed: Record<string, number> };

export type LiveLimitsView = { items: Record<string, LimitSnapshot>; removed: string[] };

export type LiveRequests = {
  at: number;
  requestId: string | null;
  requestAt: string | null;
  auditId: string | null;
  auditAt: string | null;
};

export type UsageToday = {
  at: number;
  day: string;
  spend: number;
  requests: number;
  errors: number;
  tokens: number;
};

export type LiveTopicValues = {
  limits: LiveLimits;
  requests: LiveRequests;
  usage: UsageToday;
};
