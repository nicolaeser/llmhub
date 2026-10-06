import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { DiscoveredModel, SliceRow } from "@/types/gateway";
import type { ProviderView } from "@/types/providers";

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
  spend: number;
  tokens: number;
  count: number;
  errors: number;
  rate429: number;
  latency: number;
  p95Latency: number;
  daily: { day: string; spend: number; requests: number; errors: number }[];
  byModel: SliceRow[];
  byTeam: SliceRow[];
  byOrg: SliceRow[];
  byProject: SliceRow[];
  byMember: SliceRow[];
  byKey: SliceRow[];
  byUser: SliceRow[];
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
