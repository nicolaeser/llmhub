import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { open, pkceChallenge, seal } from "@/lib/crypto";
import {
  ANTIGRAVITY_AUTHORIZE_URL,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CONTROL_URL,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPE,
  ANTIGRAVITY_TOKEN_URL,
  ANTIGRAVITY_USERINFO_URL,
  antigravityHeaders,
  antigravityPlan,
  antigravityProject,
  antigravityTier,
} from "@/lib/gateway/upstreams/antigravity";
import { antigravityClientSecret } from "@/lib/gateway/upstreams/antigravity-config";
import { CLAUDE_OAUTH_BETAS, claudeIdentityHeaders } from "@/lib/gateway/upstreams/claude";
import { KIMI_CLIENT_ID, kimiAuthHost, kimiHeaders } from "@/lib/gateway/upstreams/kimi";
import {
  MUSE_AUTH_USER_AGENT,
  MUSE_CLIENT_ID,
  MUSE_DEVICE_URL,
  MUSE_KEY_EXPIRES_AT,
  MUSE_MINT_URL,
  MUSE_TOKEN_URL,
} from "@/lib/gateway/upstreams/muse";
import { retryAfterMs } from "@/lib/gateway/upstreams/reset-credits";
import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { readJsonOr } from "@/lib/utils/json";
import { signInCredentialSchema, signInTicketSchema } from "@/schemas/providers";
import type { JsonMap } from "@/types/gateway";
import type {
  DeviceAuthorization,
  DeviceGrant,
  DevicePoll,
  KimiCodeKind,
  SignInCredential,
  SignInKind,
  SignInSession,
  SignInTicket,
  TokenRefresh,
} from "@/types/providers";

const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";
const OPENAI_DEVICE_TTL_S = 15 * 60;
const XAI_ISSUER = "https://auth.x.ai";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_REDIRECT_URI = "http://localhost:54545/callback";
const CLAUDE_SCOPE = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_AUTHORIZATION_TTL_S = 10 * 60;
const CLAUDE_OAUTH_USER_AGENT = "axios/1.15.2";
const ANTIGRAVITY_AUTHORIZATION_TTL_S = 10 * 60;
const ONBOARD_ATTEMPTS = 5;
const ONBOARD_POLL_MS = 2_000;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const AUTH_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_S = 5;
const DEFAULT_TOKEN_TTL_S = 3600;
const KIMI_DEVICE_TTL_S = 15 * 60;
const MUSE_DEVICE_TTL_S = 15 * 60;
const MUSE_DCA_PREFIX = "dca:";
const FORBIDDEN_IS_FATAL = new Set<SignInKind>(["kimi", "kimi_ai", "muse_code"]);
const FATAL_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

export function jwtClaims(token: string): JsonMap | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return asRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function tokenExpiry(access: string, expiresIn: unknown, now: number): number {
  const exp = asNumber(jwtClaims(access)?.exp, 0);
  if (exp > 0) return exp * 1000;
  const ttl = asNumber(expiresIn, DEFAULT_TOKEN_TTL_S);
  return now + (ttl > 0 ? ttl : DEFAULT_TOKEN_TTL_S) * 1000;
}

function intervalOf(value: unknown): number {
  const seconds = Math.round(asNumber(value, DEFAULT_INTERVAL_S));
  return seconds > 0 ? seconds : DEFAULT_INTERVAL_S;
}

export function openaiSession(payload: JsonMap, now = Date.now(), previous?: SignInSession): SignInSession {
  const access = asString(payload.access_token);
  if (!access) throw new Error("SIGN_IN_FAILED");
  const idClaims = jwtClaims(asString(payload.id_token)) ?? {};
  const accessClaims = jwtClaims(access) ?? {};
  const auth = asRecord(idClaims[OPENAI_AUTH_CLAIM]) ?? asRecord(accessClaims[OPENAI_AUTH_CLAIM]) ?? {};
  const profile = asRecord(accessClaims[OPENAI_PROFILE_CLAIM]) ?? {};
  return {
    tokens: {
      access,
      refresh: asString(payload.refresh_token) || previous?.tokens.refresh || "",
      accountId: asString(auth.chatgpt_account_id) || previous?.tokens.accountId || "",
      residency:
        asString(auth.chatgpt_data_residency) ||
        asString(auth.chatgpt_compute_residency) ||
        previous?.tokens.residency ||
        "",
    },
    expiresAt: tokenExpiry(access, payload.expires_in, now),
    account: asString(idClaims.email) || asString(profile.email) || previous?.account || "",
    plan: asString(auth.chatgpt_plan_type) || previous?.plan || "",
  };
}

export function xaiSession(payload: JsonMap, now = Date.now(), previous?: SignInSession): SignInSession {
  const access = asString(payload.access_token);
  if (!access) throw new Error("SIGN_IN_FAILED");
  const idClaims = jwtClaims(asString(payload.id_token)) ?? {};
  return {
    tokens: {
      access,
      refresh: asString(payload.refresh_token) || previous?.tokens.refresh || "",
      accountId: "",
      residency: "",
    },
    expiresAt: tokenExpiry(access, payload.expires_in, now),
    account:
      asString(idClaims.email) ||
      asString(idClaims.preferred_username) ||
      asString(idClaims.name) ||
      previous?.account ||
      "",
    plan: previous?.plan ?? "",
  };
}

export function kimiSession(payload: JsonMap, device: string, now = Date.now(), previous?: SignInSession): SignInSession {
  const access = asString(payload.access_token);
  if (!access) throw new Error("SIGN_IN_FAILED");
  const claims = jwtClaims(access) ?? {};
  const accountId = asString(claims.user_id) || asString(claims.sub) || previous?.tokens.accountId || "";
  return {
    tokens: {
      access,
      refresh: asString(payload.refresh_token) || previous?.tokens.refresh || "",
      accountId,
      residency: "",
      device: device || previous?.tokens.device || "",
    },
    expiresAt: tokenExpiry(access, payload.expires_in, now),
    account:
      asString(claims.email) ||
      asString(claims.preferred_username) ||
      asString(claims.name) ||
      previous?.account ||
      accountId,
    plan: previous?.plan ?? "",
  };
}

export function museSession(minted: JsonMap, dca: string, previous?: SignInSession): SignInSession {
  const access = asString(minted.api_key).trim();
  if (!access || access.startsWith(MUSE_DCA_PREFIX)) throw new Error("SIGN_IN_FAILED");
  return {
    tokens: { access, refresh: dca || previous?.tokens.refresh || "", accountId: "", residency: "" },
    expiresAt: MUSE_KEY_EXPIRES_AT,
    account: asString(minted.user_email) || previous?.account || "",
    plan: asString(minted.subs_tier_name) || previous?.plan || "",
  };
}

export function claudeSession(
  payload: JsonMap,
  now = Date.now(),
  previous?: SignInSession,
  plan = "",
): SignInSession {
  const access = asString(payload.access_token);
  if (!access) throw new Error("SIGN_IN_FAILED");
  const account = asRecord(payload.account);
  return {
    tokens: {
      access,
      refresh: asString(payload.refresh_token) || previous?.tokens.refresh || "",
      accountId: asString(account?.uuid) || previous?.tokens.accountId || "",
      residency: "",
    },
    expiresAt: tokenExpiry(access, payload.expires_in, now),
    account: asString(account?.email_address) || previous?.account || "",
    plan: plan || previous?.plan || "",
  };
}

export function claudePlan(profile: JsonMap): string {
  const account = asRecord(profile.account) ?? {};
  const organization = asRecord(profile.organization) ?? {};
  const multiplier = /max_(\d+)x/.exec(asString(organization.rate_limit_tier))?.[1];
  if (multiplier) return `max_${multiplier}x`;
  if (account.has_claude_max === true) return "max";
  if (account.has_claude_pro === true) return "pro";
  const type = asString(organization.organization_type);
  if (type === "claude_team") return "team";
  if (type === "claude_enterprise") return "enterprise";
  return "";
}

export async function claudeProfile(access: string): Promise<{ status: number; plan: string }> {
  try {
    const res = await fetch(CLAUDE_PROFILE_URL, {
      headers: {
        ...claudeIdentityHeaders(),
        Authorization: `Bearer ${access}`,
        "anthropic-beta": CLAUDE_OAUTH_BETAS.join(","),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) return { status: res.status, plan: "" };
    return { status: res.status, plan: claudePlan(asRecord(await readJsonOr(res, null)) ?? {}) };
  } catch {
    return { status: 0, plan: "" };
  }
}

export async function claudeProfilePlan(access: string): Promise<string> {
  return (await claudeProfile(access)).plan;
}

export async function googleAccess(access: string): Promise<number> {
  try {
    const res = await fetch(ANTIGRAVITY_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access}`, Accept: "application/json" },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      redirect: "error",
    });
    return res.status;
  } catch {
    return 0;
  }
}

async function postAuth(
  url: string,
  body: URLSearchParams | JsonMap,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: JsonMap; retryAfterMs: number | null }> {
  const form = body instanceof URLSearchParams;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
      Accept: "application/json",
      ...extraHeaders,
    },
    body: form ? body.toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    redirect: "error",
  }).catch(() => {
    throw new Error("SIGN_IN_FAILED");
  });
  const json = asRecord(await readJsonOr(res, null)) ?? {};
  return { status: res.status, json, retryAfterMs: retryAfterMs(res.headers.get("retry-after"), Date.now()) };
}

function errorCode(json: JsonMap): string {
  const error = json.error;
  if (typeof error === "string") return error;
  return asString(asRecord(error)?.code);
}

async function startAntigravityAuthorization(): Promise<DeviceAuthorization> {
  if (!(await antigravityClientSecret())) throw new Error("ANTIGRAVITY_NOT_CONFIGURED");
  return requestAntigravityAuthorization();
}

const AUTHORIZATION_STARTS: Record<SignInKind, () => Promise<DeviceAuthorization>> = {
  antigravity: startAntigravityAuthorization,
  claude: async () => requestAuthorizationCode(),
  codex: () => requestOpenaiDeviceCode(),
  grok_build: () => requestXaiDeviceCode(),
  kimi: () => requestKimiDeviceCode("kimi"),
  kimi_ai: () => requestKimiDeviceCode("kimi_ai"),
  muse_code: () => requestMuseDeviceCode(),
};

export function startAuthorization(kind: SignInKind): Promise<DeviceAuthorization> {
  if (!Object.hasOwn(AUTHORIZATION_STARTS, kind)) throw new Error("UNKNOWN_PROVIDER_KIND");
  return AUTHORIZATION_STARTS[kind]();
}

export function requestAntigravityAuthorization(): DeviceAuthorization {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    response_type: "code",
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    scope: ANTIGRAVITY_SCOPE,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return {
    grant: { kind: "antigravity", verifier, state },
    verificationUrl: `${ANTIGRAVITY_AUTHORIZE_URL}?${query.toString()}`,
    userCode: "",
    interval: DEFAULT_INTERVAL_S,
    expiresIn: ANTIGRAVITY_AUTHORIZATION_TTL_S,
  };
}

export function requestAuthorizationCode(): DeviceAuthorization {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_CLIENT_ID,
    response_type: "code",
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: CLAUDE_SCOPE,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    state,
  });
  return {
    grant: { kind: "claude", verifier, state },
    verificationUrl: `${CLAUDE_AUTHORIZE_URL}?${query.toString()}`,
    userCode: "",
    interval: DEFAULT_INTERVAL_S,
    expiresIn: CLAUDE_AUTHORIZATION_TTL_S,
  };
}

export function parseAuthorizationInput(input: string): { code: string; state: string } {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return { code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state") ?? "" };
    } catch {
      return { code: "", state: "" };
    }
  }
  const [code = "", state = ""] = trimmed.split("#");
  return { code: code.trim(), state: state.trim() };
}

export function antigravitySession(
  payload: JsonMap,
  now = Date.now(),
  previous?: SignInSession,
  details: { account?: string; plan?: string; project?: string } = {},
): SignInSession {
  const access = asString(payload.access_token);
  if (!access) throw new Error("SIGN_IN_FAILED");
  return {
    tokens: {
      access,
      refresh: asString(payload.refresh_token) || previous?.tokens.refresh || "",
      accountId: details.project || previous?.tokens.accountId || "",
      residency: "",
    },
    expiresAt: tokenExpiry(access, payload.expires_in, now),
    account: details.account || previous?.account || "",
    plan: details.plan || previous?.plan || "",
  };
}

export async function googleEmail(access: string): Promise<string> {
  try {
    const res = await fetch(ANTIGRAVITY_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access}`, Accept: "application/json" },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) return "";
    return asString(asRecord(await readJsonOr(res, null))?.email);
  } catch {
    return "";
  }
}

async function codeAssist(access: string, method: string, body: JsonMap): Promise<{ status: number; json: JsonMap }> {
  return postAuth(`${ANTIGRAVITY_CONTROL_URL}/v1internal:${method}`, body, {
    ...antigravityHeaders(),
    Authorization: `Bearer ${access}`,
  });
}

export async function antigravityAccount(access: string): Promise<{ project: string; plan: string }> {
  const metadata = { ideType: "ANTIGRAVITY" };
  const loaded = await codeAssist(access, "loadCodeAssist", { metadata });
  if (loaded.status >= 400) throw new Error("SIGN_IN_FAILED");
  const tier = antigravityTier(loaded.json);
  let project = antigravityProject(loaded.json);
  for (let attempt = 0; !project && attempt < ONBOARD_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_MS));
    const onboarded = await codeAssist(access, "onboardUser", { tierId: tier.onboardId, metadata });
    if (onboarded.status >= 400) throw new Error("SIGN_IN_FAILED");
    if (onboarded.json.done === true) {
      project = antigravityProject(asRecord(onboarded.json.response));
      break;
    }
  }
  if (!project) throw new Error("ANTIGRAVITY_NO_PROJECT");
  return { project, plan: antigravityPlan(tier.id) };
}

async function completeAntigravity(
  grant: Extract<DeviceGrant, { kind: "antigravity" }>,
  code: string,
): Promise<SignInSession> {
  const secret = await antigravityClientSecret();
  if (!secret) throw new Error("ANTIGRAVITY_NOT_CONFIGURED");
  const exchanged = await postAuth(
    ANTIGRAVITY_TOKEN_URL,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: secret,
      code_verifier: grant.verifier,
    }),
  );
  if (exchanged.status >= 400) throw new Error("SIGN_IN_FAILED");
  const session = antigravitySession(exchanged.json);
  if (!session.tokens.refresh) throw new Error("SIGN_IN_FAILED");
  const [account, details] = await Promise.all([googleEmail(session.tokens.access), antigravityAccount(session.tokens.access)]);
  return antigravitySession(exchanged.json, Date.now(), undefined, { account, plan: details.plan, project: details.project });
}

export async function completeAuthorization(
  grant: Extract<DeviceGrant, { kind: "claude" | "antigravity" }>,
  input: string,
): Promise<SignInSession> {
  const { code, state } = parseAuthorizationInput(input);
  if (!code || (state && state !== grant.state)) throw new Error("SIGN_IN_FAILED");
  if (grant.kind === "antigravity") return completeAntigravity(grant, code);
  const exchanged = await postAuth(
    CLAUDE_TOKEN_URL,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT_URI,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: grant.verifier,
      state: grant.state,
    },
    { "User-Agent": CLAUDE_OAUTH_USER_AGENT },
  );
  if (exchanged.status >= 400) throw new Error("SIGN_IN_FAILED");
  const session = claudeSession(exchanged.json);
  if (!session.tokens.refresh) throw new Error("SIGN_IN_FAILED");
  return { ...session, plan: await claudeProfilePlan(session.tokens.access) };
}

export async function requestOpenaiDeviceCode(): Promise<DeviceAuthorization> {
  const { status, json } = await postAuth(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
    client_id: OPENAI_CLIENT_ID,
  });
  const deviceAuthId = asString(json.device_auth_id);
  const userCode = asString(json.user_code) || asString(json.usercode);
  if (status >= 400 || !deviceAuthId || !userCode) throw new Error("SIGN_IN_FAILED");
  return {
    grant: { kind: "codex", deviceAuthId, userCode },
    verificationUrl: `${OPENAI_ISSUER}/codex/device`,
    userCode,
    interval: intervalOf(json.interval),
    expiresIn: OPENAI_DEVICE_TTL_S,
  };
}

export async function requestXaiDeviceCode(): Promise<DeviceAuthorization> {
  const { status, json } = await postAuth(
    `${XAI_ISSUER}/oauth2/device/code`,
    new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }),
  );
  const deviceCode = asString(json.device_code);
  const userCode = asString(json.user_code);
  const verificationUrl = asString(json.verification_uri_complete) || asString(json.verification_uri);
  if (status >= 400 || !deviceCode || !userCode || !verificationUrl.startsWith("https://")) {
    throw new Error("SIGN_IN_FAILED");
  }
  return {
    grant: { kind: "grok_build", deviceCode },
    verificationUrl,
    userCode,
    interval: intervalOf(json.interval),
    expiresIn: Math.max(60, Math.round(asNumber(json.expires_in, OPENAI_DEVICE_TTL_S))),
  };
}

export async function requestKimiDeviceCode(kind: KimiCodeKind): Promise<DeviceAuthorization> {
  const device = randomUUID();
  const { status, json } = await postAuth(
    `${kimiAuthHost(kind)}/api/oauth/device_authorization`,
    new URLSearchParams({ client_id: KIMI_CLIENT_ID }),
    kimiHeaders(device),
  );
  const deviceCode = asString(json.device_code);
  const userCode = asString(json.user_code);
  const verificationUrl = asString(json.verification_uri_complete) || asString(json.verification_uri);
  if (status >= 400 || !deviceCode || !userCode || !verificationUrl.startsWith("https://")) {
    throw new Error("SIGN_IN_FAILED");
  }
  return {
    grant: { kind, deviceCode, device },
    verificationUrl,
    userCode,
    interval: intervalOf(json.interval),
    expiresIn: Math.max(60, Math.round(asNumber(json.expires_in, KIMI_DEVICE_TTL_S))),
  };
}

export async function requestMuseDeviceCode(): Promise<DeviceAuthorization> {
  const { status, json } = await postAuth(MUSE_DEVICE_URL, new URLSearchParams({ client_id: MUSE_CLIENT_ID }), {
    "User-Agent": MUSE_AUTH_USER_AGENT,
  });
  const deviceCode = asString(json.device_code);
  const userCode = asString(json.user_code);
  const verificationUrl = asString(json.verification_uri_complete) || asString(json.verification_uri);
  if (status >= 400 || !deviceCode || !userCode || !verificationUrl.startsWith("https://")) {
    throw new Error("SIGN_IN_FAILED");
  }
  return {
    grant: { kind: "muse_code", deviceCode },
    verificationUrl,
    userCode,
    interval: intervalOf(json.interval),
    expiresIn: Math.max(60, Math.round(asNumber(json.expires_in, MUSE_DEVICE_TTL_S))),
  };
}

export function mintMuseKey(dca: string): Promise<{ status: number; json: JsonMap; retryAfterMs: number | null }> {
  return postAuth(MUSE_MINT_URL, { dca_token: dca }, { Authorization: `Bearer ${dca}`, "User-Agent": MUSE_AUTH_USER_AGENT });
}

function devicePending(json: JsonMap): DevicePoll | null {
  switch (errorCode(json)) {
    case "authorization_pending":
      return { state: "pending", slowDown: false };
    case "slow_down":
      return { state: "pending", slowDown: true };
    case "access_denied":
      return { state: "denied" };
    case "expired_token":
      return { state: "expired" };
    default:
      return null;
  }
}

async function pollKimi(grant: Extract<DeviceGrant, { kind: KimiCodeKind }>): Promise<DevicePoll> {
  const polled = await postAuth(
    `${kimiAuthHost(grant.kind)}/api/oauth/token`,
    new URLSearchParams({ client_id: KIMI_CLIENT_ID, device_code: grant.deviceCode, grant_type: DEVICE_GRANT_TYPE }),
    kimiHeaders(grant.device),
  );
  const waiting = devicePending(polled.json);
  if (waiting) return waiting;
  if (polled.status >= 400 || errorCode(polled.json)) throw new Error("SIGN_IN_FAILED");
  const session = kimiSession(polled.json, grant.device);
  if (!session.tokens.refresh) throw new Error("SIGN_IN_FAILED");
  return { state: "done", session };
}

async function pollMuse(grant: Extract<DeviceGrant, { kind: "muse_code" }>): Promise<DevicePoll> {
  const polled = await postAuth(
    MUSE_TOKEN_URL,
    new URLSearchParams({ grant_type: DEVICE_GRANT_TYPE, device_code: grant.deviceCode, client_id: MUSE_CLIENT_ID }),
    { "User-Agent": MUSE_AUTH_USER_AGENT },
  );
  const dca = asString(polled.json.access_token);
  if (polled.status >= 400 || !dca) {
    const waiting = devicePending(polled.json);
    if (waiting) return waiting;
    throw new Error("SIGN_IN_FAILED");
  }
  const minted = await mintMuseKey(dca);
  if (minted.status >= 400) throw new Error("SIGN_IN_FAILED");
  return { state: "done", session: museSession(minted.json, dca) };
}

async function pollOpenai(grant: Extract<DeviceGrant, { kind: "codex" }>): Promise<DevicePoll> {
  const polled = await postAuth(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
    device_auth_id: grant.deviceAuthId,
    user_code: grant.userCode,
  });
  if (polled.status === 403 || polled.status === 404) return { state: "pending", slowDown: false };
  if (polled.status === 429) return { state: "pending", slowDown: true };
  const code = asString(polled.json.authorization_code);
  const verifier = asString(polled.json.code_verifier);
  if (polled.status >= 400 || !code || !verifier) throw new Error("SIGN_IN_FAILED");
  const exchanged = await postAuth(
    `${OPENAI_ISSUER}/oauth/token`,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code,
      redirect_uri: `${OPENAI_ISSUER}/deviceauth/callback`,
      code_verifier: verifier,
    }),
  );
  if (exchanged.status >= 400) throw new Error("SIGN_IN_FAILED");
  const session = openaiSession(exchanged.json);
  if (!session.tokens.refresh || !session.tokens.accountId) throw new Error("SIGN_IN_FAILED");
  return { state: "done", session };
}

async function pollXai(grant: Extract<DeviceGrant, { kind: "grok_build" }>): Promise<DevicePoll> {
  const polled = await postAuth(
    `${XAI_ISSUER}/oauth2/token`,
    new URLSearchParams({ grant_type: DEVICE_GRANT_TYPE, device_code: grant.deviceCode, client_id: XAI_CLIENT_ID }),
  );
  if (polled.status < 400) {
    const session = xaiSession(polled.json);
    if (!session.tokens.refresh) throw new Error("SIGN_IN_FAILED");
    return { state: "done", session };
  }
  switch (errorCode(polled.json)) {
    case "authorization_pending":
      return { state: "pending", slowDown: false };
    case "slow_down":
      return { state: "pending", slowDown: true };
    case "access_denied":
      return { state: "denied" };
    case "expired_token":
      return { state: "expired" };
    default:
      throw new Error("SIGN_IN_FAILED");
  }
}

export function pollDeviceCode(grant: DeviceGrant): Promise<DevicePoll> {
  switch (grant.kind) {
    case "codex":
      return pollOpenai(grant);
    case "grok_build":
      return pollXai(grant);
    case "kimi":
    case "kimi_ai":
      return pollKimi(grant);
    case "muse_code":
      return pollMuse(grant);
    default:
      return Promise.reject(new Error("SIGN_IN_FAILED"));
  }
}

async function refreshRequest(
  kind: SignInKind,
  current: SignInSession,
): Promise<{ status: number; json: JsonMap; retryAfterMs: number | null }> {
  switch (kind) {
    case "antigravity":
      return postAuth(
        ANTIGRAVITY_TOKEN_URL,
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: await antigravityClientSecret(),
          refresh_token: current.tokens.refresh,
        }),
      );
    case "codex":
      return postAuth(`${OPENAI_ISSUER}/oauth/token`, {
        client_id: OPENAI_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: current.tokens.refresh,
      });
    case "grok_build":
      return postAuth(
        `${XAI_ISSUER}/oauth2/token`,
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: XAI_CLIENT_ID,
          refresh_token: current.tokens.refresh,
        }),
      );
    case "claude":
      return postAuth(
        CLAUDE_TOKEN_URL,
        {
          client_id: CLAUDE_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: current.tokens.refresh,
          scope: CLAUDE_SCOPE,
        },
        { "User-Agent": CLAUDE_OAUTH_USER_AGENT },
      );
    case "kimi":
    case "kimi_ai":
      return postAuth(
        `${kimiAuthHost(kind)}/api/oauth/token`,
        new URLSearchParams({
          client_id: KIMI_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: current.tokens.refresh,
        }),
        kimiHeaders(current.tokens.device),
      );
    case "muse_code":
      return mintMuseKey(current.tokens.refresh);
  }
}

function refreshedSession(kind: SignInKind, json: JsonMap, current: SignInSession): SignInSession {
  switch (kind) {
    case "codex":
      return openaiSession(json, Date.now(), current);
    case "grok_build":
      return xaiSession(json, Date.now(), current);
    case "claude":
      return claudeSession(json, Date.now(), current);
    case "antigravity":
      return antigravitySession(json, Date.now(), current);
    case "kimi":
    case "kimi_ai":
      return kimiSession(json, current.tokens.device ?? "", Date.now(), current);
    case "muse_code":
      return museSession(json, current.tokens.refresh, current);
  }
}

export async function refreshSession(kind: SignInKind, current: SignInSession): Promise<TokenRefresh> {
  if (!current.tokens.refresh) return { ok: false, fatal: true, retryAfterMs: null };
  let result: { status: number; json: JsonMap; retryAfterMs: number | null };
  try {
    result = await refreshRequest(kind, current);
  } catch {
    return { ok: false, fatal: false, retryAfterMs: null };
  }
  if (result.status >= 400) {
    const fatal =
      result.status === 401 ||
      (result.status === 403 && FORBIDDEN_IS_FATAL.has(kind)) ||
      FATAL_REFRESH_CODES.has(errorCode(result.json));
    return { ok: false, fatal, retryAfterMs: result.status === 429 ? result.retryAfterMs : null };
  }
  try {
    return { ok: true, session: refreshedSession(kind, result.json, current) };
  } catch {
    return { ok: false, fatal: false, retryAfterMs: null };
  }
}

const CREDENTIAL_TTL_MS = 30 * 60_000;

function unseal(value: string): unknown {
  try {
    return JSON.parse(open(value));
  } catch {
    return null;
  }
}

export function sealTicket(uid: string, device: DeviceAuthorization, now = Date.now()): string {
  const ticket: SignInTicket = {
    purpose: "sign_in_device",
    uid,
    exp: now + device.expiresIn * 1000,
    interval: device.interval,
    grant: device.grant,
  };
  return seal(JSON.stringify(ticket));
}

export function openTicket(value: string, uid: string, now = Date.now()): SignInTicket | null {
  const parsed = signInTicketSchema.safeParse(unseal(value));
  if (!parsed.success || parsed.data.uid !== uid || parsed.data.exp <= now) return null;
  return parsed.data;
}

export function sealCredential(uid: string, kind: SignInKind, session: SignInSession, now = Date.now()): string {
  const credential: SignInCredential = {
    purpose: "sign_in_credential",
    uid,
    kind,
    exp: now + CREDENTIAL_TTL_MS,
    session,
  };
  return seal(JSON.stringify(credential));
}

export function openCredential(value: string, uid: string, kind: string, now = Date.now()): SignInCredential | null {
  const parsed = signInCredentialSchema.safeParse(unseal(value));
  if (!parsed.success || parsed.data.uid !== uid || parsed.data.kind !== kind || parsed.data.exp <= now) return null;
  return parsed.data;
}
