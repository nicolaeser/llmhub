import type { z } from "zod";
import type { signInCredentialSchema, signInTicketSchema } from "@/schemas/providers";

export type ProviderRecord = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  discovered: unknown;
  zdr: boolean;
  retentionDays: number | null;
  region: string;
  noTraining: boolean;
  enabled: boolean;
  restricted: boolean;
  assignments?: AssignmentSource[];
  login?: { account: string; plan: string; status: string } | null;
};

export type ProviderPolicyInput = {
  zdr: boolean;
  retentionDays: number | null;
  region: string;
  noTraining: boolean;
};

export type ProviderSyncRecord = ProviderRecord & { updatedAt: Date };

export type ImportCandidate = {
  id: string;
  name: string;
  alias: string;
  exists: boolean;
};

export type SignInKind = SignInCredential["kind"];

export type SignInMethod = "device" | "code";

export type SignInStatus = "active" | "expired";

export type ProviderSignIn = {
  account: string;
  plan: string;
  status: SignInStatus;
};

export type AssignmentScope = "org" | "team" | "project" | "member" | "key";

export type AssignmentRow = {
  orgId: string | null;
  teamId: string | null;
  projectId: string | null;
  memberId: string | null;
  keyId: string | null;
};

export type AssignmentSource = AssignmentRow & {
  org?: { alias: string } | null;
  team?: { alias: string } | null;
  project?: { alias: string } | null;
  member?: { name: string; email: string } | null;
  key?: { keyAlias: string; prefix: string } | null;
};

export type AccountAccess = {
  orgId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  keyId: string;
};

export type AssignmentTarget = {
  scope: AssignmentScope;
  id: string;
  label: string;
};

export type AssignmentInput = { scope: AssignmentScope; id: string };

export type AssignmentOptions = Record<AssignmentScope, { id: string; label: string; detail?: string }[]>;

export type AccountStrategy =
  | "inherit"
  | "smart"
  | "quota_balanced"
  | "quota_expiring"
  | "round_robin"
  | "priority"
  | "least_inflight";

export type AccountRouting = Partial<Record<SignInKind, AccountStrategy>>;

export type ProviderView = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  restricted: boolean;
  assignments: AssignmentTarget[];
  signIn: ProviderSignIn | null;
  discovered: { id: string; name: string }[];
  policy: ProviderPolicyInput;
};

export type SignInSession = SignInCredential["session"];

export type SignInTokens = SignInSession["tokens"];

export type DeviceGrant = SignInTicket["grant"];

export type DeviceAuthorization = {
  grant: DeviceGrant;
  verificationUrl: string;
  userCode: string;
  interval: number;
  expiresIn: number;
};

export type DevicePoll =
  | { state: "pending"; slowDown: boolean }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "done"; session: SignInSession };

export type TokenRefresh =
  | { ok: true; session: SignInSession }
  | { ok: false; fatal: boolean };

export type SignInTicket = z.infer<typeof signInTicketSchema>;

export type SignInCredential = z.infer<typeof signInCredentialSchema>;

export type SignInStart = {
  method: SignInMethod;
  ticket: string;
  verificationUrl: string;
  userCode: string;
  interval: number;
  expiresIn: number;
};

export type LimitWindow = {
  scope: string;
  usedPercent: number;
  windowSeconds: number;
  resetsAt: string | null;
  limitReached: boolean;
};

export type SubscriptionLimits = {
  plan: string;
  windows: LimitWindow[];
  credits: { unlimited: boolean; balance: string } | null;
  resetCredits: { available: number; applicable: number } | null;
  extraUsage: { usedCents: number; limitCents: number; percent: number | null } | null;
  fetchedAt: string;
};

export type AccountLimits = {
  id: string;
  limits: SubscriptionLimits | null;
  error: string;
};

export type AccountState = "paused" | "available" | "limited" | "expired" | "unavailable" | "checking" | "connected";

export type SignInPollResult =
  | { state: "pending"; interval: number }
  | { state: "done"; credential: string; account: string; plan: string };

export type ProviderAuthMode = "api_key" | "sign_in";

export type ProviderKindSpec = {
  kind: string;
  name: string;
  default_base_url?: string;
  auth?: ProviderAuthMode;
};

export type UpstreamAuth = {
  key: string;
  headers: Record<string, string>;
  project?: string;
};

export type DiscoveredModel = {
  id: string;
  name: string;
  ownedBy: string;
  contextLength: number;
  costInputPer1k: number;
  costOutputPer1k: number;
  priceSource: string;
  serviceTiers?: string[];
  accessPrograms?: string[];
};

export type ModelPrice = { in: number; out: number };

export type RepricedModel = { id: string; from: ModelPrice; to: ModelPrice };

export type DiscoveredDiff = {
  added: string[];
  removed: string[];
  repriced: RepricedModel[];
  changed: boolean;
};

export type ProviderModelPrice = {
  id: string;
  costInput: number;
  costOutput: number;
  priceSource: string;
};

export type AntigravitySettings = {
  client_secret: string;
};

export type ProviderListActions = {
  openForm: (spec: ProviderKindSpec | null, row: ProviderView | null, onSaved?: (provider: ProviderView) => void) => void;
  openImport: (row: ProviderView) => void;
  replace: (provider: ProviderView) => void;
  remove: (id: string) => void;
};

export type ProvidersTab = "api" | "subscriptions" | "health";
