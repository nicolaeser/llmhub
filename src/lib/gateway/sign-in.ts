import "server-only";
import { open, seal } from "@/lib/crypto";
import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { signInCredentialSchema, signInTicketSchema } from "@/schemas/providers";
import type { JsonMap } from "@/types/gateway";
import type {
  DeviceAuthorization,
  DeviceGrant,
  DevicePoll,
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
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const AUTH_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_S = 5;
const DEFAULT_TOKEN_TTL_S = 3600;
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

async function postAuth(url: string, body: URLSearchParams | JsonMap): Promise<{ status: number; json: JsonMap }> {
  const form = body instanceof URLSearchParams;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
      Accept: "application/json",
    },
    body: form ? body.toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    redirect: "error",
  }).catch(() => {
    throw new Error("SIGN_IN_FAILED");
  });
  const json = asRecord(await res.json().catch(() => null)) ?? {};
  return { status: res.status, json };
}

function errorCode(json: JsonMap): string {
  const error = json.error;
  if (typeof error === "string") return error;
  return asString(asRecord(error)?.code);
}

export async function requestDeviceCode(kind: SignInKind): Promise<DeviceAuthorization> {
  if (kind === "codex") {
    const { status, json } = await postAuth(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
      client_id: OPENAI_CLIENT_ID,
    });
    const deviceAuthId = asString(json.device_auth_id);
    const userCode = asString(json.user_code) || asString(json.usercode);
    if (status >= 400 || !deviceAuthId || !userCode) throw new Error("SIGN_IN_FAILED");
    return {
      grant: { kind, deviceAuthId, userCode },
      verificationUrl: `${OPENAI_ISSUER}/codex/device`,
      userCode,
      interval: intervalOf(json.interval),
      expiresIn: OPENAI_DEVICE_TTL_S,
    };
  }
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
    grant: { kind, deviceCode },
    verificationUrl,
    userCode,
    interval: intervalOf(json.interval),
    expiresIn: Math.max(60, Math.round(asNumber(json.expires_in, OPENAI_DEVICE_TTL_S))),
  };
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
  return grant.kind === "codex" ? pollOpenai(grant) : pollXai(grant);
}

export async function refreshSession(kind: SignInKind, current: SignInSession): Promise<TokenRefresh> {
  if (!current.tokens.refresh) return { ok: false, fatal: true };
  let result: { status: number; json: JsonMap };
  try {
    result =
      kind === "codex"
        ? await postAuth(`${OPENAI_ISSUER}/oauth/token`, {
            client_id: OPENAI_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: current.tokens.refresh,
          })
        : await postAuth(
            `${XAI_ISSUER}/oauth2/token`,
            new URLSearchParams({
              grant_type: "refresh_token",
              client_id: XAI_CLIENT_ID,
              refresh_token: current.tokens.refresh,
            }),
          );
  } catch {
    return { ok: false, fatal: false };
  }
  if (result.status >= 400) {
    const fatal = result.status === 401 || FATAL_REFRESH_CODES.has(errorCode(result.json));
    return { ok: false, fatal };
  }
  try {
    const session =
      kind === "codex" ? openaiSession(result.json, Date.now(), current) : xaiSession(result.json, Date.now(), current);
    return { ok: true, session };
  } catch {
    return { ok: false, fatal: false };
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
