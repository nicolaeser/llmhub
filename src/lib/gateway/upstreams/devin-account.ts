import { randomBytes } from "node:crypto";
import { asRecord, asString } from "@/lib/gateway/core";
import { ProtoWriter, WIRE_BYTES, WIRE_VARINT, protoFields, protoNumber, protoText, safeProtoFields } from "@/lib/gateway/upstreams/devin-wire";
import type { JsonMap } from "@/types/gateway";
import type { DevinProfile, DevinUserStatus } from "@/types/devin";
import type { LimitWindow, SignInSession, SubscriptionLimits } from "@/types/providers";

const DEVIN_APP_URL = "https://app.devin.ai";
export const DEVIN_API_URL = "https://api.devin.ai";
export const DEVIN_SERVER_URL = "https://server.codeium.com";
export const DEVIN_CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_MODELS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
export const DEVIN_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
export const DEVIN_TOKEN_URL = `${DEVIN_API_URL}/auth/cli/token`;
export const DEVIN_PROFILE_URL = `${DEVIN_API_URL}/v3/self`;
export const DEVIN_CLIENT_NAME = "chisel";
export const DEVIN_CLIENT_VERSION = "3000.10.21";
export const DEVIN_CATALOG_USER_AGENT = "connect-go/1.19.1 (go1.25.0)";
export const DEVIN_SESSION_EXPIRES_AT = Date.UTC(9999, 11, 31);
export const DEVIN_DAY_SECONDS = 86_400;
export const DEVIN_WEEK_SECONDS = 7 * DEVIN_DAY_SECONDS;

const SESSION_TOKEN_PREFIX = "devin-session-token$";
const JWT_PREFIX = "eyJ";
const FINGERPRINT_BYTES = 366;
const CLIENT_LOCALE = "en";
const PLATFORM_NAMES: Readonly<Record<string, string>> = { win32: "windows" };

function devinPlatform(platform: string = process.platform): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

function deviceFingerprint(): string {
  return randomBytes(FINGERPRINT_BYTES).toString("hex");
}

export function devinBasicAuth(token: string): string {
  return `Basic ${token}-${token}`;
}

export function devinSentryTrace(): string {
  const hex = randomBytes(24).toString("hex");
  return `${hex.slice(0, 32)}-${hex.slice(32, 48)}-1`;
}

export function devinHeaders(token: string): Record<string, string> {
  return {
    Authorization: devinBasicAuth(token),
    "Content-Type": "application/connect+proto",
    "Connect-Protocol-Version": "1",
    Accept: "*/*",
    "Sentry-Trace": devinSentryTrace(),
    "User-Agent": "",
  };
}

export function clientMetadata(token: string, fingerprint = deviceFingerprint()): ProtoWriter {
  return new ProtoWriter()
    .string(1, DEVIN_CLIENT_NAME)
    .string(2, DEVIN_CLIENT_VERSION)
    .string(3, token)
    .string(4, CLIENT_LOCALE)
    .string(5, devinPlatform())
    .string(7, DEVIN_CLIENT_VERSION)
    .string(12, DEVIN_CLIENT_NAME)
    .string(31, fingerprint);
}

export function devinMetadataRequest(token: string): Uint8Array<ArrayBuffer> {
  return new ProtoWriter().message(1, clientMetadata(token)).finish();
}

export function formatSessionToken(raw: string): string {
  const token = raw.trim();
  if (token.startsWith(JWT_PREFIX)) return `${SESSION_TOKEN_PREFIX}${token}`;
  return token;
}

export function pastedSessionToken(input: string): string {
  const trimmed = input.trim().replace(/^["']+|["']+$/g, "").trim();
  if (trimmed.startsWith(SESSION_TOKEN_PREFIX) || trimmed.startsWith(JWT_PREFIX)) return formatSessionToken(trimmed);
  return "";
}

export function devinAuthorizationUrl(challenge: string, state: string): string {
  const query = [
    `state=${encodeURIComponent(state)}`,
    "prompt=select_account",
    `code_challenge=${encodeURIComponent(challenge)}`,
    "code_challenge_method=S256",
    "cli_pkce_marker=1",
  ].join("&");
  return `${DEVIN_APP_URL}/auth/cli/continue?${query}`;
}

function seconds(data: Uint8Array): number | null {
  const field = safeProtoFields(data).find((item) => item.field === 1 && item.wire === WIRE_VARINT);
  const value = field ? protoNumber(field) : 0;
  return value > 0 ? value * 1000 : null;
}

function emptyStatus(): DevinUserStatus {
  return {
    email: "",
    userName: "",
    userId: "",
    teamId: "",
    orgId: "",
    orgName: "",
    plan: "",
    dailyRemaining: null,
    weeklyRemaining: null,
    dailyResetAt: null,
    weeklyResetAt: null,
    planStart: null,
    planEnd: null,
  };
}

function readOrg(data: Uint8Array, status: DevinUserStatus): void {
  for (const field of safeProtoFields(data)) {
    if (field.wire !== WIRE_BYTES) continue;
    if (field.field === 4) status.orgId = protoText(field);
    if (field.field === 8) status.orgName = protoText(field);
  }
}

function readPlanInfo(data: Uint8Array, status: DevinUserStatus): void {
  for (const field of safeProtoFields(data)) {
    if (field.wire !== WIRE_BYTES) continue;
    if (field.field === 2) status.plan = protoText(field);
    if (field.field === 33) readOrg(field.bytes, status);
  }
}

function readPlanStatus(data: Uint8Array, status: DevinUserStatus): void {
  for (const field of safeProtoFields(data)) {
    if (field.wire === WIRE_BYTES) {
      if (field.field === 1) readPlanInfo(field.bytes, status);
      if (field.field === 2) status.planStart = seconds(field.bytes);
      if (field.field === 3) status.planEnd = seconds(field.bytes);
      continue;
    }
    if (field.wire !== WIRE_VARINT) continue;
    const value = protoNumber(field);
    if (field.field === 14) status.dailyRemaining = value;
    if (field.field === 15) status.weeklyRemaining = value;
    if (field.field === 17 && value > 0) status.dailyResetAt = value * 1000;
    if (field.field === 18 && value > 0) status.weeklyResetAt = value * 1000;
  }
}

function readUserStatus(data: Uint8Array, status: DevinUserStatus): void {
  for (const field of safeProtoFields(data)) {
    if (field.wire !== WIRE_BYTES) continue;
    if (field.field === 3) status.userName = protoText(field);
    if (field.field === 5) status.teamId = protoText(field);
    if (field.field === 7) status.email = protoText(field);
    if (field.field === 13) readPlanStatus(field.bytes, status);
    if (field.field === 36) status.userId = protoText(field);
  }
}

export function parseDevinStatus(data: Uint8Array): DevinUserStatus {
  if (!data.length) throw new Error("DEVIN_STATUS_EMPTY");
  const status = emptyStatus();
  for (const field of protoFields(data)) {
    if (field.field === 1 && field.wire === WIRE_BYTES) readUserStatus(field.bytes, status);
  }
  return status;
}

function quotaWindow(remaining: number | null, resetAt: number | null, windowSeconds: number): LimitWindow | null {
  if (remaining === null && resetAt === null) return null;
  const left = Math.min(100, Math.max(0, remaining ?? 0));
  return {
    scope: "",
    usedPercent: 100 - left,
    windowSeconds,
    resetsAt: resetAt ? new Date(resetAt).toISOString() : null,
    limitReached: left <= 0,
  };
}

export function devinLimits(status: DevinUserStatus, now = Date.now()): SubscriptionLimits {
  const windows = [
    quotaWindow(status.dailyRemaining, status.dailyResetAt, DEVIN_DAY_SECONDS),
    quotaWindow(status.weeklyRemaining, status.weeklyResetAt, DEVIN_WEEK_SECONDS),
  ].filter((window): window is LimitWindow => window !== null);
  return { plan: status.plan, windows, credits: null, resetCredits: null, extraUsage: null, fetchedAt: new Date(now).toISOString() };
}

export function devinProfileOf(json: unknown): DevinProfile {
  const rec: JsonMap = asRecord(json) ?? {};
  return { userName: asString(rec.user_name), userId: asString(rec.user_id), orgId: asString(rec.org_id) };
}

export function devinSession(
  token: string,
  details: { status?: DevinUserStatus | null; profile?: DevinProfile | null; account?: string; accountId?: string; plan?: string },
  previous?: SignInSession,
): SignInSession {
  const status = details.status ?? null;
  const profile = details.profile ?? null;
  const accountId = profile?.userId || status?.userId || details.accountId || previous?.tokens.accountId || "";
  const account =
    status?.email ||
    details.account ||
    previous?.account ||
    profile?.userName ||
    status?.userName ||
    accountId;
  return {
    tokens: { access: token, refresh: token, accountId, residency: "" },
    expiresAt: DEVIN_SESSION_EXPIRES_AT,
    account,
    plan: status?.plan || details.plan || previous?.plan || "",
  };
}

export function windowReset(limits: SubscriptionLimits | null, windowSeconds: number, now = Date.now()): number | null {
  const window = limits?.windows.find((item) => item.windowSeconds === windowSeconds && item.resetsAt);
  const at = window?.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (!Number.isFinite(at) || at <= now || at - now > DEVIN_WEEK_SECONDS * 1000 + DEVIN_DAY_SECONDS * 1000) return null;
  return at;
}
