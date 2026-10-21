import "server-only";
import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { antigravityClientSecret } from "@/lib/gateway/upstreams/antigravity-config";
import { CODEX_USAGE_URL } from "@/lib/gateway/upstreams/codex";
import { signInHeaders } from "@/lib/gateway/upstreams/credentials";
import { devinSession, formatSessionToken } from "@/lib/gateway/upstreams/devin-account";
import { devinProfile, devinStatusReply, readDevinStatus } from "@/lib/gateway/upstreams/devin-api";
import {
  antigravityAccount,
  antigravitySession,
  claudeProfile,
  claudeSession,
  googleAccess,
  googleEmail,
  jwtClaims,
  openaiSession,
  refreshSession,
  xaiSession,
} from "@/lib/gateway/upstreams/subscription-sign-in";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { JsonMap } from "@/types/gateway";
import type { AuthFileAccount, SignInKind, SignInSession } from "@/types/providers";

const REFRESH_SKEW_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const REJECTED_STATUS = 401;
const MAX_NESTING = 3;
const MILLISECOND_EPOCH = 1e12;

const AUTH_FILE_KINDS: Record<string, SignInKind> = {
  codex: "codex",
  claude: "claude",
  anthropic: "claude",
  antigravity: "antigravity",
  "anti-gravity": "antigravity",
  xai: "grok_build",
  devin: "devin",
};

const DEVIN_TOKEN_KEYS = ["session_token", "api_key", "token"];
const DEVIN_REJECTED = new Set([401, 403]);

const EXPIRY_KEYS = ["expired", "expire", "expires_at", "expiresAt", "expiry", "expires"];
const LIFETIME_KEYS = ["expires_in", "expiresIn"];
const ISSUED_KEYS = ["timestamp", "issued_at", "issuedAt"];
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PLAIN_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
const NUMERIC = /^\d+(?:\.\d+)?$/;

type EntryTokens = { record: JsonMap; access: string; refresh: string; expiresAt: number };

function text(record: JsonMap, key: string): string {
  return asString(record[key]).trim();
}

function firstText(records: JsonMap[], keys: string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = text(record, key);
      if (value) return value;
    }
  }
  return "";
}

function isTyped(value: unknown): boolean {
  return typeof asRecord(value)?.type === "string";
}

function collectEntries(value: unknown, depth: number): unknown[] {
  if (Array.isArray(value)) {
    return depth < MAX_NESTING ? value.flatMap((item) => collectEntries(item, depth + 1)) : value;
  }
  const record = asRecord(value);
  if (!record || Object.hasOwn(record, "type") || depth >= MAX_NESTING) return [value];
  const nested = Object.values(record)
    .filter((child) => Array.isArray(child) || asRecord(child))
    .flatMap((child) => collectEntries(child, depth + 1))
    .filter(isTyped);
  return nested.length ? nested : [value];
}

function pieceEnd(text: string, start: number, implicit: boolean): { end: number; closers: string } {
  const open: string[] = implicit ? ["}"] : [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") open.push("}");
    else if (char === "[") open.push("]");
    else if (char === "}" || char === "]") {
      if (open.pop() !== char || !open.length) return { end: index + 1, closers: "" };
    }
  }
  return { end: text.length, closers: open.reverse().join("") };
}

type JsonPiece = { text: string; repaired: boolean };

function jsonPieces(text: string): JsonPiece[] | null {
  const pieces: JsonPiece[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "," || /\s/.test(char)) {
      index += 1;
      continue;
    }
    const implicit = char === '"';
    if (!implicit && char !== "{" && char !== "[") return null;
    const { end, closers } = pieceEnd(text, index, implicit);
    pieces.push({ text: `${implicit ? "{" : ""}${text.slice(index, end)}${closers}`, repaired: implicit || closers !== "" });
    index = end;
  }
  return pieces;
}

function authFileValues(content: string): unknown[] {
  const text = content.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  const whole = parseJsonOrNull(text);
  if (whole !== null) return [whole];
  return (jsonPieces(text) ?? []).map((piece) => {
    const value = parseJsonOrNull(piece.text);
    return piece.repaired && !(value && typeof value === "object" && Object.keys(value).length) ? null : value;
  });
}

export function authFileEntries(content: string): unknown[] {
  const values = authFileValues(content);
  if (!values.some((value) => value !== null && typeof value === "object")) throw new Error("AUTH_FILE_INVALID");
  const entries = values.flatMap((value) => (value !== null && typeof value === "object" ? collectEntries(value, 0) : [null]));
  if (!entries.length) throw new Error("AUTH_FILE_INVALID");
  return entries;
}

export function authFileKind(entry: unknown): SignInKind | null {
  const type = asString(asRecord(entry)?.type).trim().toLowerCase();
  return Object.hasOwn(AUTH_FILE_KINDS, type) ? AUTH_FILE_KINDS[type]! : null;
}

export function authFileEntryFor(entries: unknown[], kind: SignInKind): unknown {
  const match = entries.find((entry) => authFileKind(entry) === kind);
  if (match !== undefined) return match;
  if (entries.some((entry) => authFileKind(entry) !== null)) throw new Error("AUTH_FILE_KIND_MISMATCH");
  return entries[0];
}

export function authFileInstant(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > MILLISECOND_EPOCH ? value : value * 1000;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase();
  if (NUMERIC.test(raw)) return authFileInstant(Number(raw));
  if (RFC3339.test(raw)) {
    const at = Date.parse(raw);
    return Number.isFinite(at) && at > 0 ? at : null;
  }
  const plain = PLAIN_TIME.exec(raw);
  if (!plain) return null;
  const [, year, month, day, hour, minute, second = "0"] = plain;
  const at = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return at > 0 ? at : null;
}

function recordExpiry(record: JsonMap): number | null {
  for (const key of EXPIRY_KEYS) {
    const at = authFileInstant(record[key]);
    if (at !== null) return at;
  }
  const lifetimeKey = LIFETIME_KEYS.find((key) => asNumber(record[key], 0) > 0);
  const issuedKey = ISSUED_KEYS.find((key) => authFileInstant(record[key]) !== null);
  if (!lifetimeKey || !issuedKey) return null;
  return authFileInstant(record[issuedKey])! + asNumber(record[lifetimeKey], 0) * 1000;
}

export function authFileExpiry(record: JsonMap, access: string): number | null {
  const exp = asNumber(jwtClaims(access)?.exp, 0);
  if (exp > 0) return exp * 1000;
  return recordExpiry(record) ?? recordExpiry(asRecord(record.token) ?? {});
}

const SESSION_BUILDERS: Record<Exclude<SignInKind, "devin">, (entry: EntryTokens) => SignInSession> = {
  codex: ({ record, access, refresh, expiresAt }) => {
    const claims = openaiSession({ access_token: access, refresh_token: refresh, id_token: text(record, "id_token") });
    return {
      tokens: { ...claims.tokens, accountId: text(record, "account_id") || claims.tokens.accountId },
      expiresAt,
      account: text(record, "email") || claims.account,
      plan: text(record, "plan_type") || claims.plan,
    };
  },
  claude: ({ record, access, refresh, expiresAt }) => ({
    ...claudeSession({
      access_token: access,
      refresh_token: refresh,
      account: { uuid: text(record, "account_uuid"), email_address: text(record, "email") },
    }),
    expiresAt,
  }),
  grok_build: ({ record, access, refresh, expiresAt }) => {
    const claims = xaiSession({ access_token: access, refresh_token: refresh, id_token: text(record, "id_token") });
    return { ...claims, expiresAt, account: text(record, "email") || claims.account };
  },
  antigravity: ({ record, access, refresh, expiresAt }) => ({
    ...antigravitySession({ access_token: access, refresh_token: refresh }, Date.now(), undefined, {
      account: text(record, "email"),
      project: firstText([record], ["project_id", "projectId"]),
    }),
    expiresAt,
  }),
};

function devinFileAccount(record: JsonMap): AuthFileAccount {
  const metadata = asRecord(record.metadata) ?? {};
  const raw = firstText([record, metadata], DEVIN_TOKEN_KEYS);
  if (!raw) throw new Error("AUTH_FILE_INCOMPLETE");
  const records = [record, metadata];
  const session = devinSession(formatSessionToken(raw), {
    account: firstText(records, ["email"]) || firstText(records, ["user_name"]),
    accountId: firstText(records, ["user_id"]),
    plan: firstText(records, ["plan"]),
  });
  return { kind: "devin", session, needsProject: false };
}

export function parseAuthFileEntry(entry: unknown): AuthFileAccount {
  const record = asRecord(entry);
  if (!record) throw new Error("AUTH_FILE_INVALID");
  const kind = authFileKind(record);
  if (!kind || (kind === "codex" && record.use_siwc === true)) throw new Error("AUTH_FILE_UNSUPPORTED");
  if (kind === "devin") return devinFileAccount(record);
  const token = asRecord(record.token) ?? {};
  const access = firstText([record, token], ["access_token", "accessToken"]);
  const refresh = firstText([record, token], ["refresh_token", "refreshToken"]);
  if (!access || !refresh) throw new Error("AUTH_FILE_INCOMPLETE");
  const session = SESSION_BUILDERS[kind]({ record, access, refresh, expiresAt: authFileExpiry(record, access) ?? 0 });
  if (kind === "codex" && !session.tokens.accountId) throw new Error("AUTH_FILE_INCOMPLETE");
  return { kind, session, needsProject: kind === "antigravity" && !session.tokens.accountId };
}

async function renewed(kind: SignInKind, session: SignInSession, now: number): Promise<SignInSession> {
  const outcome = await refreshSession(kind, session);
  if (outcome.ok) return outcome.session;
  if (outcome.fatal) throw new Error("AUTH_FILE_EXPIRED");
  if (session.expiresAt > now) return session;
  throw new Error("UPSTREAM_FAILED");
}

async function codexUsageStatus(session: SignInSession): Promise<number> {
  try {
    const res = await fetch(CODEX_USAGE_URL, {
      headers: {
        ...signInHeaders("codex", session.tokens),
        Authorization: `Bearer ${session.tokens.access}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "error",
    });
    return res.status;
  } catch {
    return 0;
  }
}

async function accessCheck(kind: SignInKind, session: SignInSession): Promise<{ status: number; plan: string }> {
  if (kind === "codex") return { status: await codexUsageStatus(session), plan: "" };
  if (kind === "claude") return claudeProfile(session.tokens.access);
  if (kind === "antigravity") return { status: await googleAccess(session.tokens.access), plan: "" };
  return { status: 0, plan: "" };
}

async function acceptedSession(kind: SignInKind, session: SignInSession, renewedNow: boolean): Promise<SignInSession> {
  const first = await accessCheck(kind, session);
  if (first.status !== REJECTED_STATUS) return first.plan && !session.plan ? { ...session, plan: first.plan } : session;
  if (renewedNow) throw new Error("AUTH_FILE_REVOKED");
  const outcome = await refreshSession(kind, session);
  if (!outcome.ok) throw new Error(outcome.fatal ? "AUTH_FILE_REVOKED" : "UPSTREAM_FAILED");
  const second = await accessCheck(kind, outcome.session);
  if (second.status === REJECTED_STATUS) throw new Error("AUTH_FILE_REVOKED");
  return second.plan && !outcome.session.plan ? { ...outcome.session, plan: second.plan } : outcome.session;
}

async function antigravityDetails(session: SignInSession): Promise<{ project: string; plan: string }> {
  const project = session.tokens.accountId;
  if (!project) return antigravityAccount(session.tokens.access);
  if (session.plan) return { project, plan: session.plan };
  const plan = await antigravityAccount(session.tokens.access).then(
    (details) => details.plan,
    () => "",
  );
  return { project, plan };
}

async function withAntigravityDetails(session: SignInSession): Promise<SignInSession> {
  const [account, details] = await Promise.all([
    session.account || googleEmail(session.tokens.access),
    antigravityDetails(session),
  ]);
  return { ...session, tokens: { ...session.tokens, accountId: details.project }, account, plan: details.plan };
}

async function freshDevinSession(stored: SignInSession): Promise<SignInSession> {
  const token = stored.tokens.access;
  const [reply, profile] = await Promise.all([devinStatusReply(token), devinProfile(token)]);
  if (DEVIN_REJECTED.has(reply.status)) throw new Error("AUTH_FILE_REVOKED");
  const session = devinSession(token, { status: readDevinStatus(reply), profile }, stored);
  if (!session.account) throw new Error("AUTH_FILE_INCOMPLETE");
  return session;
}

export async function freshAuthFileSession(account: AuthFileAccount, now = Date.now()): Promise<SignInSession> {
  const { kind } = account;
  if (kind === "devin") return freshDevinSession(account.session);
  if (kind === "antigravity" && !(await antigravityClientSecret())) throw new Error("ANTIGRAVITY_NOT_CONFIGURED");
  const stored = account.session;
  const current = stored.expiresAt - now <= REFRESH_SKEW_MS ? await renewed(kind, stored, now) : stored;
  let session = await acceptedSession(kind, current, current !== stored);
  if (kind === "antigravity") session = await withAntigravityDetails(session);
  return session;
}
