import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { SliceRow, UsageDay } from "@/types/usage";
import type { ProviderView, DiscoveredModel } from "@/types/providers";

export type ManagementKeyView = {
  id: string;
  name: string;
  prefix: string;
  permissions: Permission[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type ManagementKeysPayload = {
  keys: ManagementKeyView[];
  grantable: Permission[];
};

export type ManagementContext<P> = {
  req: Request;
  principal: AuthenticatedSession;
  params: P;
};

export type ManagementHandler<P> = (ctx: ManagementContext<P>) => Promise<Response>;

export type ManagementRouteContext<P> = { params: Promise<P> };

export type ManagementKeyRow = {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export type ProviderSource = Omit<ProviderView, "discovered"> & { discovered: DiscoveredModel[] };

export type UsageSource = {
  days: number;
  model: string;
  teamId: string;
  orgId: string;
  projectId: string;
  memberId: string;
  keyId: string;
  userId: string;
  labelKey?: string;
  labelValue?: string;
  spend: number;
  purchase?: number | null;
  tokens: number;
  count: number;
  errors: number;
  rate429: number;
  latency: number;
  p95Latency: number;
  cacheRead: number;
  cacheWrite: number;
  cacheSavings: number;
  cacheHitRate: number;
  daily: UsageDay[];
  byModel: SliceRow[];
  byTeam: SliceRow[];
  byOrg: SliceRow[];
  byProject: SliceRow[];
  byMember: SliceRow[];
  byKey: SliceRow[];
  byUser: SliceRow[];
  byLabel?: SliceRow[];
  chargeback: SliceRow[];
};

export type SpendLogSource = {
  id: string;
  createdAt: string;
  model: string;
  spend: number;
  promptTokens: number;
  completionTokens: number;
};

export type AuditLogSource = {
  id: string;
  createdAt: string;
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
  before: string;
  after: string;
};
