import {
  CLAUDE_FIVE_HOUR_SECONDS,
  CLAUDE_MODEL_LIMIT_KEY,
  CLAUDE_WEEK_SECONDS,
  CLAUDE_WINDOWS,
  isModelLimitWindow,
  scopeKey,
} from "@/lib/gateway/upstreams/claude-usage";
import type { LimitWindow } from "@/types/providers";
import type {
  ClaudeResetBlock,
  ClaudeResetGrant,
  ClaudeUnavailableReason,
  ResetBlocker,
  ResetCreditView,
  ResetFamily,
  ResetLimit,
  ResetOption,
  ResetOptionRules,
  ResetTrigger,
} from "@/types/resets";

export const FIVE_HOUR_LIMIT = "five_hour";
export const WEEKLY_LIMIT = "seven_day";
export const MODEL_LIMIT = "seven_day_overage_included";
const FULL_PERCENT = 100;
const PLAN_LIMITS: readonly string[] = [FIVE_HOUR_LIMIT, WEEKLY_LIMIT];
const REASON_LIMITS: Partial<Record<ClaudeUnavailableReason, string>> = {
  blocked_five_hour: FIVE_HOUR_LIMIT,
  blocked_seven_day: WEEKLY_LIMIT,
  blocked_opus: "seven_day_opus",
  blocked_sonnet: "seven_day_sonnet",
};
const OTHER_LIMIT_REASONS: readonly ClaudeUnavailableReason[] = [
  "blocked_five_hour",
  "blocked_seven_day",
  "blocked_opus",
  "blocked_sonnet",
  "blocked_other",
  "cannot_clear",
];

export const RESET_CHOICE_REQUIRED = "RESET_CHOICE_REQUIRED";
export const RESET_NOT_AVAILABLE = "RESET_NOT_AVAILABLE";
export const RESET_BLOCKER_CODES: Record<ResetBlocker, string> = {
  ineligible: "RESET_INELIGIBLE",
  cooldown: "RESET_COOLDOWN",
  paused: "RESET_PAUSED",
  not_started: "RESET_NOT_STARTED",
  not_usable: "RESET_NOT_USABLE",
  exhausted: "RESET_EXHAUSTED",
  needs_limit: "RESET_NEEDS_LIMIT",
  other_limit: "RESET_OTHER_LIMIT",
  nothing_to_give_back: "RESET_NOTHING_TO_GIVE_BACK",
  pending: "RESET_PENDING",
};

type LiveLimit = { limit: ResetLimit; window: LimitWindow; lapsed: boolean };
type Returned = "none" | "some" | "unknown";
type ResetView = { options: ResetOption[]; limits: ResetLimit[] };

function after(iso: string | null, now: number): boolean {
  return iso !== null && Date.parse(iso) > now;
}

function resetPassed(window: LimitWindow, now: number): boolean {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return Number.isFinite(resetsAt) && resetsAt <= now;
}

function liveWindow(window: LimitWindow, now: number): LimitWindow {
  if (!resetPassed(window, now)) return window;
  const reset = { ...window, usedPercent: 0, limitReached: false };
  return window.usedPercentOfWeekly === undefined ? reset : { ...reset, usedPercentOfWeekly: 0 };
}

function planFamily(window: LimitWindow): ResetLimit["family"] {
  if (window.key === FIVE_HOUR_LIMIT || window.windowSeconds === CLAUDE_FIVE_HOUR_SECONDS) return "five_hour";
  if (window.key === WEEKLY_LIMIT || window.windowSeconds === CLAUDE_WEEK_SECONDS) return "weekly";
  return "other";
}

function planKey(window: LimitWindow): string {
  const family = planFamily(window);
  if (family === "five_hour") return FIVE_HOUR_LIMIT;
  if (family === "weekly") return WEEKLY_LIMIT;
  return `plan_${window.windowSeconds}`;
}

function grantWindowKey(usageKey: string): string {
  return usageKey === CLAUDE_MODEL_LIMIT_KEY ? MODEL_LIMIT : usageKey;
}

function claudeScopedKey(window: LimitWindow): string | null {
  if (window.windowSeconds <= 0) return null;
  if (isModelLimitWindow(window)) return MODEL_LIMIT;
  const spec = CLAUDE_WINDOWS.find(
    (item) => item.scope && (item.key === window.key || scopeKey(item.scope) === scopeKey(window.scope)),
  );
  return spec ? grantWindowKey(spec.key) : null;
}

function limitOf(key: string, family: ResetLimit["family"], raw: LimitWindow, now: number): LiveLimit {
  const window = liveWindow(raw, now);
  return {
    lapsed: resetPassed(raw, now),
    limit: {
      key,
      family,
      scope: window.scope,
      usedPercent: window.usedPercent,
      limitReached: window.limitReached,
      resetsAt: window.resetsAt,
    },
    window,
  };
}

function unique(limits: LiveLimit[]): LiveLimit[] {
  const seen = new Set<string>();
  return limits.filter((item) => {
    if (seen.has(item.limit.key)) return false;
    seen.add(item.limit.key);
    return true;
  });
}

function claudeLiveLimits(windows: LimitWindow[], now: number): LiveLimit[] {
  return unique(
    windows.map((window) => {
      if (!window.scope) return limitOf(planKey(window), planFamily(window), window, now);
      if (window.windowSeconds <= 0) return limitOf(`pool_${scopeKey(window.scope)}`, "other", window, now);
      return limitOf(claudeScopedKey(window) ?? `scoped_${scopeKey(window.scope)}`, "scoped", window, now);
    }),
  );
}

function genericLiveLimits(windows: LimitWindow[], now: number): LiveLimit[] {
  return unique(
    windows.map((window) => {
      if (!window.scope) return limitOf(planKey(window), planFamily(window), window, now);
      return limitOf(`scoped_${scopeKey(window.scope)}_${window.windowSeconds}`, "scoped", window, now);
    }),
  );
}

function reachedAt(limit: ResetLimit, rules: ResetOptionRules): boolean {
  const threshold = Math.min(FULL_PERCENT, rules.reachedPercent ?? FULL_PERCENT);
  return limit.limitReached || (limit.usedPercent !== null && limit.usedPercent >= threshold);
}

function knownGrantLimit(key: string): { family: ResetLimit["family"]; scope: string } {
  if (key === FIVE_HOUR_LIMIT) return { family: "five_hour", scope: "" };
  if (key === WEEKLY_LIMIT) return { family: "weekly", scope: "" };
  const spec = CLAUDE_WINDOWS.find((item) => item.scope && grantWindowKey(item.key) === key);
  return spec ? { family: "scoped", scope: spec.scope } : { family: "other", scope: "" };
}

function unseenLimit(key: string, grant: ClaudeResetGrant, block: ClaudeResetBlock): ResetLimit {
  return {
    key,
    ...knownGrantLimit(key),
    usedPercent: grant.percentUsed[key] ?? null,
    limitReached: block.exhausted.includes(key),
    resetsAt: key === WEEKLY_LIMIT ? block.weeklyResetsAt : null,
  };
}

function optionFamily(grant: ClaudeResetGrant, refills: ResetLimit[]): ResetFamily {
  if (grant.givesBackWeekly) return "scoped";
  if (!refills.length) {
    if (grant.type === "session") return "five_hour";
    return grant.type ?? "other";
  }
  const fiveHour = refills.some((limit) => limit.key === FIVE_HOUR_LIMIT);
  const weekly = refills.some((limit) => limit.key === WEEKLY_LIMIT);
  if (fiveHour && weekly) return "full";
  if (weekly) return "weekly";
  if (fiveHour) return refills.length === 1 ? "five_hour" : "other";
  return refills.every((limit) => limit.family === "scoped") ? "scoped" : "other";
}

function named(limit: ResetLimit): boolean {
  if (limit.family === "scoped") return limit.scope !== "";
  return limit.family !== "other";
}

function firstNamed(limits: ResetLimit[]): ResetLimit | null {
  return limits.find(named) ?? limits[0] ?? null;
}

function scopeNames(limits: ResetLimit[]): string {
  return [...new Set(limits.map((limit) => limit.scope).filter(Boolean))].join(", ");
}

function weeklyShare(window: LimitWindow): number | null {
  if (window.usedPercentOfWeekly !== undefined) return window.usedPercentOfWeekly;
  if (window.usedPercent === 0) return 0;
  if (window.allowancePercentOfWeekly === undefined) return null;
  return Math.round(window.usedPercent * window.allowancePercentOfWeekly) / FULL_PERCENT;
}

function returnedBy(grant: ClaudeResetGrant, model: LiveLimit | undefined): { returned: Returned; percent: number | null } {
  if (model) {
    const percent = weeklyShare(model.window);
    const used = percent ?? model.window.usedPercent;
    return { returned: used > 0 ? "some" : "none", percent };
  }
  const used = grant.percentUsed[MODEL_LIMIT];
  if (used === undefined) return { returned: "unknown", percent: null };
  return used > 0 ? { returned: "some", percent: null } : { returned: "none", percent: 0 };
}

function expiryOrder(a: ResetOption, b: ResetOption): number {
  const left = a.expiresAt ? Date.parse(a.expiresAt) : Infinity;
  const right = b.expiresAt ? Date.parse(b.expiresAt) : Infinity;
  if (left !== right) return left - right;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function fit(option: ResetOption, reached: ReadonlySet<string>): { missed: number; spare: number } {
  const refilled = new Set(option.refills.map((limit) => limit.key));
  return {
    missed: [...reached].filter((key) => !refilled.has(key)).length,
    spare: [...refilled].filter((key) => !reached.has(key)).length,
  };
}

function withRecommended(
  options: ResetOption[],
  preferredId: string,
  reached: ReadonlySet<string> = new Set(),
): ResetOption[] {
  const [pick] = options
    .filter((option) => option.blocker === null && option.helpsNow)
    .map((option) => ({ option, ...fit(option, reached) }))
    .sort(
      (a, b) =>
        a.missed - b.missed ||
        a.spare - b.spare ||
        Number(b.option.id === preferredId) - Number(a.option.id === preferredId) ||
        expiryOrder(a.option, b.option),
    );
  return options.map((option) => ({ ...option, recommended: option.id === pick?.option.id }));
}

export function claudeResetOptions(
  block: ClaudeResetBlock,
  windows: LimitWindow[],
  now: number,
  rules: ResetOptionRules = {},
): ResetView {
  const live = claudeLiveLimits(windows, now);
  const byKey = new Map(live.map((item) => [item.limit.key, item]));
  const trustExhausted = rules.exhaustedIsCurrent !== false;
  const reached = new Set(
    live.filter((item) => item.window.windowSeconds > 0 && reachedAt(item.limit, rules)).map((item) => item.limit.key),
  );
  for (const key of block.exhausted) {
    const seen = byKey.get(key);
    if (!seen || (trustExhausted && !seen.lapsed)) reached.add(key);
  }
  const limitUnknown = block.atLimit && !reached.size && !live.length;
  const notAtLimit = trustExhausted && !block.atLimit;
  const noKnownLimit = !reached.size && !limitUnknown;
  const cooling = after(block.cooldownUntil, now);
  const model = byKey.get(MODEL_LIMIT);
  const options = block.grants
    .filter((grant) => grant.endsAt === null || after(grant.endsAt, now))
    .map((grant): ResetOption => {
      const keys = [...new Set([...grant.clears, ...(grant.givesBackWeekly ? [MODEL_LIMIT] : [])])];
      const limitFor = (key: string) => byKey.get(key)?.limit ?? unseenLimit(key, grant, block);
      const refills = keys.map(limitFor);
      const back = grant.givesBackWeekly ? returnedBy(grant, model) : null;
      const noneBack =
        back !== null &&
        (back.returned === "none" ||
          grant.blocking.includes(WEEKLY_LIMIT) ||
          grant.unavailableReason === "blocked_seven_day");
      const eases = (key: string) => keys.includes(key) || (key === WEEKLY_LIMIT && back !== null && !noneBack);
      const helps = (key: string) => keys.includes(key) || (key === WEEKLY_LIMIT && back?.returned === "some" && !noneBack);
      const staysBlocked = PLAN_LIMITS.some((key) => reached.has(key) && !eases(key));
      const missesLimit = reached.size > 0 && (![...reached].some(eases) || staysBlocked);
      const reason = grant.unavailableReason;
      let blocker: ResetBlocker | null = null;
      if (!block.eligible) blocker = "ineligible";
      else if (cooling || reason === "cooldown") blocker = "cooldown";
      else if (grant.paused) blocker = "paused";
      else if (after(grant.startsAt, now)) blocker = "not_started";
      else if (grant.resetsLeft <= 0) blocker = "exhausted";
      else if (noneBack) blocker = "nothing_to_give_back";
      else if ((reason !== null && OTHER_LIMIT_REASONS.includes(reason)) || grant.blocking.length > 0 || missesLimit) {
        blocker = "other_limit";
      } else if (reason === "needs_limit" || (grant.useRequiresLimit && (notAtLimit || noKnownLimit))) {
        blocker = "needs_limit";
      } else if (!grant.usableNow || reason !== null) blocker = "not_usable";
      const leftFull = [...PLAN_LIMITS, ...reached].filter((key) => reached.has(key) && !eases(key));
      const reasonLimit = reason === null ? undefined : REASON_LIMITS[reason];
      const blockedBy =
        blocker === "other_limit"
          ? firstNamed([...new Set([...(reasonLimit ? [reasonLimit] : []), ...grant.blocking, ...leftFull])].map(limitFor))
          : null;
      const family = optionFamily(grant, refills);
      const scope = model?.limit.scope ?? knownGrantLimit(MODEL_LIMIT).scope;
      return {
        id: grant.id,
        family,
        scope: back ? scope : family === "scoped" ? scopeNames(refills) : "",
        label: grant.label,
        refills,
        givesBack: back ? { scope, percentOfWeekly: noneBack && back.returned !== "some" ? 0 : back.percent } : null,
        movesWeeklyResetDay: false,
        left: grant.resetsLeft,
        total: grant.resetsTotal,
        expiresAt: grant.endsAt,
        blocker,
        blockedBy,
        helpsNow: [...reached].some(helps) && !staysBlocked,
        recommended: false,
      };
    });
  return { options: withRecommended(options, block.nextGrantId, reached), limits: live.map((item) => item.limit) };
}

export function codexResetOptions(
  applicable: number,
  credits: ResetCreditView[],
  windows: LimitWindow[],
  now: number,
  rules: ResetOptionRules = {},
): ResetView {
  const limits = genericLiveLimits(windows, now).map((item) => item.limit);
  const refills = limits.filter((limit) => !limit.scope);
  const helpsNow = refills.some((limit) => reachedAt(limit, rules));
  const blocker: ResetBlocker | null = applicable > 0 ? null : helpsNow ? "not_usable" : "needs_limit";
  const options = credits.map(
    (credit): ResetOption => ({
      id: credit.id,
      family: "full",
      scope: "",
      label: credit.title,
      refills,
      givesBack: null,
      movesWeeklyResetDay: true,
      left: 1,
      total: 1,
      expiresAt: credit.expiresAt,
      blocker,
      blockedBy: null,
      helpsNow,
      recommended: false,
    }),
  );
  return { options: withRecommended(options, ""), limits };
}

export function pendingOptions(options: ResetOption[]): ResetOption[] {
  return options.map((option) => ({ ...option, blocker: "pending", blockedBy: null, recommended: false }));
}

export function spendableResets(options: ResetOption[]): number {
  return options.filter((option) => option.blocker === null).reduce((sum, option) => sum + option.left, 0);
}

export function pickResetOption(options: ResetOption[], choice: string, trigger: ResetTrigger): ResetOption {
  if (trigger === "auto") {
    const recommended = options.find((option) => option.recommended && option.helpsNow && option.blocker === null);
    if (!recommended || (choice && choice !== recommended.id)) throw new Error(RESET_NOT_AVAILABLE);
    return recommended;
  }
  if (choice) {
    const chosen = options.find((option) => option.id === choice);
    if (!chosen) throw new Error(RESET_NOT_AVAILABLE);
    if (chosen.blocker) throw new Error(RESET_BLOCKER_CODES[chosen.blocker]);
    return chosen;
  }
  const spendable = options.filter((option) => option.blocker === null);
  if (spendable.length > 1) throw new Error(RESET_CHOICE_REQUIRED);
  if (spendable[0]) return spendable[0];
  const blockers = new Set(options.map((option) => option.blocker));
  const [only] = blockers;
  throw new Error(blockers.size === 1 && only ? RESET_BLOCKER_CODES[only] : RESET_NOT_AVAILABLE);
}
