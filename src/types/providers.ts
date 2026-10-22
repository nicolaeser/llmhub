import type { z } from "zod";
import type { signInCredentialSchema, signInTicketSchema } from "@/schemas/providers";
import type { ActionFail } from "@/types/actions";
import type { AutoResetPolicies, ResetCredits } from "@/types/resets";

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
  internal: boolean;
  assignments?: AssignmentSource[];
  login?: { account: string; plan: string; status: string } | null;
  subAdd?: { label: string; manageHash: string | null } | null;
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

export type RotatingSignInKind = Exclude<SignInKind, "devin">;
export type KimiCodeKind = Extract<SignInKind, "kimi" | "kimi_ai">;

export type SignInMethod = "device" | "code";

export type SignInStatus = "active" | "expired";

export type SignInCheck = "valid" | "rejected" | "unreachable";

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

export type AccessMode = "open" | "limited";

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

export type AccountRoutingView = {
  routing: AccountRouting;
  autoReset: AutoResetPolicies;
  canManage: boolean;
};

export type ProviderView = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  restricted: boolean;
  internal: boolean;
  assignments: AssignmentTarget[];
  signIn: ProviderSignIn | null;
  sharedVia: string | null;
  manageActive: boolean;
  discovered: { id: string; name: string }[];
  policy: ProviderPolicyInput;
  vertex: VertexView | null;
};

export type SignInSession = SignInCredential["session"];

export type SignInTokens = SignInSession["tokens"];

export type DeviceGrant = SignInTicket["grant"];

export type CodeGrant = Extract<DeviceGrant, { kind: "claude" | "antigravity" | "devin" }>;

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

export type LoginRefreshMode =
  | { reason: "expiring" }
  | { reason: "scheduled" }
  | { reason: "rejected"; version: number };

export type TokenRefresh =
  | { ok: true; session: SignInSession }
  | { ok: false; fatal: boolean; retryAfterMs: number | null };

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
  label?: string;
  usedPercent: number;
  windowSeconds: number;
  resetsAt: string | null;
  limitReached: boolean;
};

export type AntigravityFamily = "gemini_pro" | "gemini_flash" | "gemini_image" | "claude" | "gpt_oss" | "other";

export type LimitGroupMember = {
  scope: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  limitReached: boolean;
};

export type LimitGroup = {
  id: string;
  scoped: boolean;
  family: AntigravityFamily | null;
  label: string;
  windowSeconds: number;
  members: LimitGroupMember[];
  usedPercent: number;
  resetsAt: string | null;
  limitReached: boolean;
  exhausted: boolean;
  uniform: boolean;
};

export type LimitSummary = {
  groups: LimitGroup[];
  more: number;
};

export type PartialLimits = {
  reached: number;
  total: number;
};

export type SubscriptionLimits = {
  plan: string;
  windows: LimitWindow[];
  credits: { unlimited: boolean; balance: string } | null;
  resetCredits: ResetCredits | null;
  extraUsage: { usedCents: number; limitCents: number; percent: number | null } | null;
  fetchedAt: string;
  observedAt?: string;
};

export type AccountLimits = {
  id: string;
  limits: SubscriptionLimits | null;
  error: string;
};

export type LimitErrorCode = "SIGN_IN_EXPIRED" | "UPSTREAM_AUTH" | "UPSTREAM_FAILED" | "UPSTREAM_RATE_LIMITED";

export type LimitSnapshot = AccountLimits & {
  version: number;
  checkedAt: string | null;
  nextAt: string | null;
  retryAt: string | null;
};

export type LimitSnapshotList = { at: number; items: LimitSnapshot[] };

export type LimitAccount = { id: string; kind: string; apiKey: string };

export type LimitPollAccount = LimitAccount & { enabled: boolean; loginVersion: number };

export type StoredLimitSnapshot = {
  providerId: string;
  limits: SubscriptionLimits | null;
  resets: ResetCredits | null;
  resetsAt: number | null;
  error: string;
  fetchedAt: number | null;
  checkedAt: number | null;
  nextAt: number;
  retryAt: number | null;
  failures: number;
  loginVersion: number;
  leaseUntil: number | null;
  version: number;
};

export type LimitFetchFailure = { code: LimitErrorCode; retryAfterMs: number | null };

export type LimitRefreshMode = { kind: "scheduled" } | { kind: "manual" } | { kind: "fresh"; maxAgeMs: number };

export type LimitRefreshResult = {
  status: "fetched" | "skipped" | "busy" | "gone";
  limits: SubscriptionLimits | null;
  failure: LimitFetchFailure | null;
  snapshot: StoredLimitSnapshot | null;
};

export type AccountState = "paused" | "available" | "limited" | "expired" | "unavailable" | "checking" | "connected";

export type SignInPollResult =
  | { state: "pending"; interval: number }
  | { state: "done"; credential: string; account: string; plan: string };

export type SignInFinish = { account: string; plan: string };

export type SignInFlowStep<T extends SignInFinish> = { state: "pending"; interval: number } | ({ state: "done" } & T);

export type SignInFlowActions<T extends SignInFinish> = {
  start: (kind: SignInKind) => Promise<SignInStart | ActionFail>;
  poll: (input: { ticket: string; interval: number }) => Promise<SignInFlowStep<T> | ActionFail>;
  complete: (input: { ticket: string; code: string }) => Promise<SignInFlowStep<T> | ActionFail>;
  importFile?: (kind: SignInKind, content: string) => Promise<T | ActionFail>;
};

export type AuthFileAccount = {
  kind: SignInKind;
  session: SignInSession;
  needsProject: boolean;
};

export type AuthFileUpload = { name: string; content: string };

export type AuthFileStatus = "created" | "updated" | "failed";

export type AuthFileResult = {
  file: string;
  kind?: SignInKind;
  account?: string;
  plan?: string;
  status: AuthFileStatus;
  error?: string;
};

export type AuthFileImport = {
  results: AuthFileResult[];
  providers: ProviderView[];
  superseded: string[];
};

export type CliProxyAuthFile = {
  name: string;
  type: string;
  kind: SignInKind | null;
  account: string;
  status: string;
  disabled: boolean;
  importable: boolean;
};

export type CliProxyListing = { version: string; files: CliProxyAuthFile[] };

export type CliProxyImport = AuthFileImport & { removed: string[]; keptAtSource: string[] };

export type SignInFileResult = {
  credential: string;
  account: string;
  plan: string;
};

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
  keyHeader?: string;
};

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export type VertexTarget = { project: string; location: string };

export type VertexRoute = "google" | "anthropic" | "openapi";

export type VertexModelRoute = { route: VertexRoute; model: string };

export type ServiceAccount = {
  type: "service_account";
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
};

export type VertexCredentialKind = "service_account" | "api_key";

export type VertexCredential =
  | { type: "service_account"; account: ServiceAccount }
  | { type: "api_key"; key: string };

export type VertexView = {
  credential: VertexCredentialKind;
  account: string;
  project: string;
  location: string;
};

export type VertexDraft = {
  credential: VertexCredentialKind;
  serviceAccount: string;
  project: string;
  location: string;
};

export type VertexConnectionInput = {
  credential: string;
  target?: Partial<VertexTarget>;
  baseUrl?: string;
  currentBaseUrl?: string;
};

export type GoogleAccessToken = { token: string; expiresAt: number };

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
  variants?: string[];
};

export type DiscoveredPage = { models: DiscoveredModel[]; next: string };

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

export type AntigravityClientState = {
  saved: boolean;
  bundled: boolean;
};

export type ProviderListActions = {
  openForm: (spec: ProviderKindSpec | null, row: ProviderView | null) => void;
  openImport: (row: ProviderView) => void;
  replace: (provider: ProviderView) => void;
  remove: (id: string) => void;
};

export type ProvidersTab = "api" | "subscriptions" | "links" | "health";

export type ProviderDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
  signIn: string;
  vertex: VertexDraft;
  zdr: boolean;
  retention: string;
  region: string;
  noTraining: boolean;
  internal: boolean;
};

export type ProviderBody = {
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  signIn?: string;
  policy: ProviderPolicyInput;
  vertex?: VertexTarget;
  internal?: boolean;
};

export type AddProviderSection = "api" | "subscription" | "import";

export type AddProviderFilter = "all" | AddProviderSection;

export type ImportOption = "files" | "server" | "link";

export type AuthFileSource = "files" | "paste" | "server";

export type AddProviderOption =
  | { id: string; section: "api" | "subscription"; spec: ProviderKindSpec }
  | { id: string; section: "import"; option: ImportOption };

export type AddProviderPreset = { kind: string | null; filter: AddProviderFilter };
