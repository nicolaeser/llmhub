import { asRecord, asString } from "@/lib/gateway/core";
import { CLAUDE_OAUTH_BETAS } from "@/lib/gateway/upstreams/claude";
import { readJsonOr } from "@/lib/utils/json";
import { CLAUDE_GRANT_ID, CLAUDE_REQUEST_ID, ORG_UUID } from "@/schemas/resets";
import type { JsonMap } from "@/types/gateway";
import type { UpstreamAuth } from "@/types/providers";
import type {
  ClaudeClaim,
  ClaudeIneligibleReason,
  ClaudeRedeemResult,
  ClaudeResetBlock,
  ClaudeResetGrant,
  CodexClaim,
  CodexCreditList,
  CodexRedeemResult,
  CodexResetCredit,
  CodexResetCreditStatus,
  RedeemOutcome,
  ResetCredits,
  ResetResult,
  StatusRead,
} from "@/types/resets";

export const CODEX_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const CODEX_CONSUME_URL = `${CODEX_CREDITS_URL}/consume`;
export const CLAUDE_RESETS_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_ORGANIZATIONS_URL = "https://api.anthropic.com/api/organizations";
const CLAUDE_PROGRAM = "cedar_ember";
const READ_TIMEOUT_MS = 15_000;
const CODEX_CONSUME_TIMEOUT_MS = 10_000;
const CLAUDE_CLAIM_TIMEOUT_MS = 25_000;
const MAX_LABEL_LENGTH = 120;
const MAX_CREDIT_ID_LENGTH = 200;
const MAX_RETRY_AFTER_MS = 24 * 3_600_000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;
const WINDOW_NAME = /^[a-z0-9_]{1,64}$/;
const RETRY_AFTER_SECONDS = /^\d+$/;

const INELIGIBLE_REASONS = [
  "config_off",
  "tier",
  "seat",
  "mobile",
  "surface",
  "cli_version",
  "no_grant",
  "tenure",
  "other_experiment",
  "unavailable",
  "unknown",
] as const satisfies readonly ClaudeIneligibleReason[];
const CODEX_RESULTS = ["reset", "nothing_to_reset", "no_credit", "already_redeemed"] as const satisfies readonly CodexRedeemResult[];
const CLAUDE_RESULTS = [
  "reset",
  "already_used",
  "not_limited",
  "cooldown",
  "ineligible",
  "unavailable",
] as const satisfies readonly ClaudeRedeemResult[];
const CREDIT_STATUSES = ["available", "redeeming", "redeemed"] as const satisfies readonly CodexResetCreditStatus[];
const SUCCESS_RESULTS: ReadonlySet<ResetResult> = new Set<ResetResult>(["reset", "already_redeemed", "already_used"]);
const UNPRINTABLE_RANGES: readonly [number, number][] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

export function redeemSucceeded(result: ResetResult): boolean {
  return SUCCESS_RESULTS.has(result);
}

function printable(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return !UNPRINTABLE_RANGES.some(([low, high]) => code >= low && code <= high);
}

export function sanitizeLabel(value: string): string {
  return [...[...value].filter(printable).join("").trim()].slice(0, MAX_LABEL_LENGTH).join("").trim();
}

function timestamp(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !RFC3339.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function flag(value: unknown, fallback: boolean): boolean | undefined {
  if (value === undefined || value === null) return fallback;
  return typeof value === "boolean" ? value : undefined;
}

function windowList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !WINDOW_NAME.test(item)) return undefined;
    names.add(item);
  }
  return [...names];
}

function percentMap(value: unknown): Record<string, number> | undefined {
  if (value === undefined || value === null) return {};
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, number> = {};
  for (const [name, percent] of Object.entries(record)) {
    if (!WINDOW_NAME.test(name)) return undefined;
    if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 0 || percent > 100) return undefined;
    out[name] = percent;
  }
  return out;
}

function claudeGrant(raw: unknown): ClaudeResetGrant | null {
  const grant = asRecord(raw);
  if (!grant) return null;
  const id = grant.id;
  if (typeof id !== "string" || !CLAUDE_GRANT_ID.test(id)) return null;
  if (grant.label !== undefined && grant.label !== null && typeof grant.label !== "string") return null;
  const resetsTotal = count(grant.resets_total);
  const resetsLeft = count(grant.resets_left);
  if (resetsTotal === undefined || resetsLeft === undefined || resetsLeft > resetsTotal) return null;
  const startsAt = timestamp(grant.starts_at);
  const endsAt = timestamp(grant.ends_at);
  const clears = windowList(grant.clears);
  const paused = flag(grant.paused, false);
  const usableNow = flag(grant.usable_now, false);
  const useRequiresLimit = flag(grant.use_requires_limit, true);
  const percentUsed = percentMap(grant.percent_used);
  if (
    startsAt === undefined ||
    endsAt === undefined ||
    clears === undefined ||
    paused === undefined ||
    usableNow === undefined ||
    useRequiresLimit === undefined ||
    percentUsed === undefined
  ) {
    return null;
  }
  return {
    id,
    label: sanitizeLabel(asString(grant.label)),
    resetsTotal,
    resetsLeft,
    startsAt,
    endsAt,
    clears,
    paused,
    usableNow,
    useRequiresLimit,
    percentUsed,
  };
}

function ineligibleReason(value: unknown): ClaudeIneligibleReason | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  return INELIGIBLE_REASONS.find((reason) => reason === value) ?? "unknown";
}

export function parseClaudeResets(payload: JsonMap | null): ClaudeResetBlock | null {
  const block = asRecord(payload?.cedar_ember);
  if (!block || typeof block.eligible !== "boolean") return null;
  const reason = ineligibleReason(block.ineligible_reason);
  const atLimit = flag(block.at_limit, false);
  const weeklyResetsAt = timestamp(block.weekly_resets_at);
  const cooldownUntil = timestamp(block.cooldown_until);
  if (reason === undefined || atLimit === undefined || weeklyResetsAt === undefined || cooldownUntil === undefined) {
    return null;
  }
  const next = block.next_grant_id;
  if (next !== undefined && next !== null && (typeof next !== "string" || !CLAUDE_GRANT_ID.test(next))) return null;
  if (block.grants !== undefined && block.grants !== null && !Array.isArray(block.grants)) return null;
  const grants: ClaudeResetGrant[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(block.grants) ? block.grants : []) {
    const grant = claudeGrant(raw);
    if (!grant || ids.has(grant.id)) return null;
    ids.add(grant.id);
    grants.push(grant);
  }
  return {
    eligible: block.eligible,
    ineligibleReason: block.eligible ? null : (reason ?? "unknown"),
    atLimit,
    grants,
    nextGrantId: typeof next === "string" ? next : "",
    weeklyResetsAt,
    cooldownUntil,
  };
}

function after(iso: string | null, now: number): boolean {
  return iso !== null && Date.parse(iso) > now;
}

function grantLive(grant: ClaudeResetGrant, now: number): boolean {
  return grant.endsAt === null || after(grant.endsAt, now);
}

export function grantUsable(grant: ClaudeResetGrant, atLimit: boolean, now: number): boolean {
  return (
    !grant.paused &&
    grant.usableNow &&
    grant.resetsLeft > 0 &&
    !after(grant.startsAt, now) &&
    grantLive(grant, now) &&
    (!grant.useRequiresLimit || atLimit)
  );
}

function claudeCooling(block: ClaudeResetBlock, now: number): boolean {
  return after(block.cooldownUntil, now);
}

function byId(a: ClaudeResetGrant, b: ClaudeResetGrant): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function selectGrant(block: ClaudeResetBlock | null, now: number): ClaudeResetGrant | null {
  if (!block?.eligible || claudeCooling(block, now)) return null;
  const usable = block.grants.filter((grant) => grantUsable(grant, block.atLimit, now));
  if (!usable.length) return null;
  return usable.find((grant) => grant.id === block.nextGrantId) ?? [...usable].sort(byId)[0]!;
}

function soonest(values: (string | null)[]): string | null {
  const times = values.filter((value): value is string => value !== null).sort((a, b) => Date.parse(a) - Date.parse(b));
  return times[0] ?? null;
}

export function claudeResetCredits(block: ClaudeResetBlock, now: number): ResetCredits {
  const live = block.grants.filter((grant) => grantLive(grant, now));
  const cooling = claudeCooling(block, now);
  const selectable = block.eligible && !cooling;
  const usable = new Set(
    selectable ? live.filter((grant) => grantUsable(grant, block.atLimit, now)).map((grant) => grant.id) : [],
  );
  return {
    available: live.reduce((sum, grant) => sum + grant.resetsLeft, 0),
    applicable: live.filter((grant) => usable.has(grant.id)).reduce((sum, grant) => sum + grant.resetsLeft, 0),
    expiresAt: soonest(live.filter((grant) => grant.resetsLeft > 0).map((grant) => grant.endsAt)),
    grants: live.map((grant) => ({
      id: grant.id,
      label: grant.label,
      resetsLeft: grant.resetsLeft,
      resetsTotal: grant.resetsTotal,
      endsAt: grant.endsAt,
      clears: grant.clears,
      usable: usable.has(grant.id),
    })),
    eligible: block.eligible,
    ineligibleReason: block.ineligibleReason,
    atLimit: block.atLimit,
    cooldownUntil: cooling ? block.cooldownUntil : null,
  };
}

function codexCredit(raw: unknown): CodexResetCredit | null {
  const credit = asRecord(raw);
  if (!credit) return null;
  const id = credit.id;
  if (typeof id !== "string" || !id || id.length > MAX_CREDIT_ID_LENGTH) return null;
  if (credit.reset_type !== undefined && credit.reset_type !== "codex_rate_limits") return null;
  const status = CREDIT_STATUSES.find((item) => item === credit.status);
  if (!status) return null;
  return {
    id,
    status,
    grantedAt: timestamp(credit.granted_at) ?? null,
    expiresAt: timestamp(credit.expires_at) ?? null,
    title: sanitizeLabel(asString(credit.title)),
    description: sanitizeLabel(asString(credit.description)),
  };
}

export function parseCodexCredits(payload: JsonMap | null): CodexCreditList | null {
  if (!payload || !Array.isArray(payload.credits)) return null;
  const credits = payload.credits.flatMap((raw) => codexCredit(raw) ?? []);
  return {
    credits,
    availableCount: count(payload.available_count) ?? credits.filter((credit) => credit.status === "available").length,
    totalEarnedCount: count(payload.total_earned_count) ?? 0,
    purchaseEligible: payload.immediate_reset_purchase_eligible === true,
  };
}

function expiryOrder(a: CodexResetCredit, b: CodexResetCredit): number {
  const left = a.expiresAt ? Date.parse(a.expiresAt) : Infinity;
  const right = b.expiresAt ? Date.parse(b.expiresAt) : Infinity;
  return left === right ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : left - right;
}

function liveCredits(list: CodexCreditList | null, now: number): CodexResetCredit[] {
  if (!list) return [];
  return list.credits
    .filter((credit) => credit.status === "available" && (credit.expiresAt === null || after(credit.expiresAt, now)))
    .sort(expiryOrder);
}

export function soonestCredit(list: CodexCreditList | null, now: number): CodexResetCredit | null {
  return liveCredits(list, now)[0] ?? null;
}

export function codexResetCredits(
  base: Pick<ResetCredits, "available" | "applicable"> | null,
  list: CodexCreditList | null,
  now: number,
): ResetCredits | null {
  if (!base && !list) return null;
  const live = liveCredits(list, now);
  return {
    available: base?.available ?? list?.availableCount ?? 0,
    applicable: base?.applicable ?? 0,
    expiresAt: live[0]?.expiresAt ?? null,
    credits: live.map((credit) => ({ id: credit.id, title: credit.title, expiresAt: credit.expiresAt })),
  };
}

export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const value = header.trim();
  const ms = RETRY_AFTER_SECONDS.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
}

async function send(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; json: JsonMap | null; retryAfterMs: number | null }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    const retryAfter = retryAfterMs(res.headers.get("retry-after"), Date.now());
    return { status: res.status, json: asRecord(await readJsonOr(res, null)), retryAfterMs: retryAfter };
  } catch {
    return { status: 0, json: null, retryAfterMs: null };
  }
}

function bearer(auth: UpstreamAuth, body: boolean, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/json",
    ...auth.headers,
    ...extra,
    ...(body ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${auth.key}`,
  };
}

function claudeBetas(): Record<string, string> {
  return { "anthropic-beta": CLAUDE_OAUTH_BETAS.join(",") };
}

export async function fetchCodexCredits(auth: UpstreamAuth): Promise<StatusRead<CodexCreditList>> {
  const res = await send(CODEX_CREDITS_URL, { headers: bearer(auth, false) }, READ_TIMEOUT_MS);
  const ok = res.status >= 200 && res.status < 300;
  return { status: res.status, value: ok ? parseCodexCredits(res.json) : null, retryAfterMs: res.retryAfterMs };
}

export async function fetchClaudeResets(auth: UpstreamAuth): Promise<StatusRead<ClaudeResetBlock>> {
  const res = await send(CLAUDE_RESETS_URL, { headers: bearer(auth, false, claudeBetas()) }, READ_TIMEOUT_MS);
  const ok = res.status >= 200 && res.status < 300;
  return { status: res.status, value: ok ? parseClaudeResets(res.json) : null, retryAfterMs: res.retryAfterMs };
}

export async function fetchClaudeOrg(auth: UpstreamAuth): Promise<string> {
  const res = await send(CLAUDE_PROFILE_URL, { headers: bearer(auth, false, claudeBetas()) }, READ_TIMEOUT_MS);
  if (res.status < 200 || res.status >= 300) return "";
  const uuid = asString(asRecord(res.json?.organization)?.uuid);
  return ORG_UUID.test(uuid) ? uuid.toLowerCase() : "";
}

function rejected(status: number): ResetResult | null {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_error";
  return null;
}

function answered(status: number): boolean {
  return status >= 200 && status < 500;
}

export function codexOutcome(status: number, json: JsonMap | null): RedeemOutcome {
  const known = rejected(status);
  if (known) return { result: known, windowsReset: 0 };
  const result = answered(status) ? CODEX_RESULTS.find((item) => item === json?.code) : undefined;
  if (!result) return { result: "unknown", windowsReset: 0 };
  const windows = json?.windows_reset;
  return {
    result,
    windowsReset: typeof windows === "number" && Number.isInteger(windows) && windows > 0 ? windows : 0,
  };
}

export function claudeOutcome(status: number, json: JsonMap | null): RedeemOutcome {
  const known = rejected(status);
  if (known) return { result: known, windowsReset: 0 };
  const result = answered(status) ? CLAUDE_RESULTS.find((item) => item === json?.result) : undefined;
  return { result: result ?? "unknown", windowsReset: 0 };
}

export async function consumeCodexCredit(auth: UpstreamAuth, claim: CodexClaim): Promise<RedeemOutcome> {
  const body: JsonMap = { redeem_request_id: claim.redeemRequestId };
  if (claim.creditId) body.credit_id = claim.creditId;
  const res = await send(
    CODEX_CONSUME_URL,
    { method: "POST", headers: bearer(auth, true), body: JSON.stringify(body) },
    CODEX_CONSUME_TIMEOUT_MS,
  );
  return codexOutcome(res.status, res.json);
}

export async function claimClaudeReset(auth: UpstreamAuth, claim: ClaudeClaim): Promise<RedeemOutcome> {
  if (!ORG_UUID.test(claim.orgUuid) || !CLAUDE_GRANT_ID.test(claim.grantId) || !CLAUDE_REQUEST_ID.test(claim.requestId)) {
    throw new Error("VALIDATION");
  }
  const res = await send(
    `${CLAUDE_ORGANIZATIONS_URL}/${claim.orgUuid}/reset_rate_limits`,
    {
      method: "POST",
      headers: bearer(auth, true, claudeBetas()),
      body: JSON.stringify({ program: CLAUDE_PROGRAM, grant_id: claim.grantId, request_id: claim.requestId }),
    },
    CLAUDE_CLAIM_TIMEOUT_MS,
  );
  return claudeOutcome(res.status, res.json);
}
