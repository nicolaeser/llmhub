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

export type SignInKind = "codex" | "grok_build";

export type SignInStatus = "active" | "expired";

export type ProviderSignIn = {
  account: string;
  plan: string;
  status: SignInStatus;
};

export type ProviderView = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  signIn: ProviderSignIn | null;
  discovered: { id: string; name: string }[];
  policy: ProviderPolicyInput;
};

export type SignInTokens = {
  access: string;
  refresh: string;
  accountId: string;
  residency: string;
};

export type SignInSession = {
  tokens: SignInTokens;
  expiresAt: number;
  account: string;
  plan: string;
};

export type DeviceGrant =
  | { kind: "codex"; deviceAuthId: string; userCode: string }
  | { kind: "grok_build"; deviceCode: string };

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

export type SignInTicket = {
  purpose: "sign_in_device";
  uid: string;
  exp: number;
  interval: number;
  grant: DeviceGrant;
};

export type SignInCredential = {
  purpose: "sign_in_credential";
  uid: string;
  kind: SignInKind;
  exp: number;
  session: SignInSession;
};

export type SignInStart = {
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
  fetchedAt: string;
};

export type SignInPollResult =
  | { state: "pending"; interval: number }
  | { state: "done"; credential: string; account: string; plan: string };
