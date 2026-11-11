import type { ProviderView } from "@/types/providers";
import type { ResetBlocker, ResetCredits, ResetFamily, ResetLimit, ResetOption } from "@/types/resets";

export type ResetWait = "cooldown" | "limit" | "ineligible";

export function canRedeemReset(row: Pick<ProviderView, "signIn">, credits: ResetCredits, canManage: boolean): boolean {
  return canManage && credits.canRedeem === true && row.signIn?.status === "active";
}

export function showsResetSummary(credits: ResetCredits | null | undefined): credits is ResetCredits {
  return Boolean(credits) && (credits!.available > 0 || Boolean(credits!.pending));
}

export function resetWaitsFor(credits: ResetCredits, now: number): ResetWait | null {
  if (credits.pending || credits.canRedeem === true) return null;
  if (credits.cooldownUntil && Date.parse(credits.cooldownUntil) > now) return "cooldown";
  if (credits.eligible === false) return "ineligible";
  if (credits.applicable === 0 && credits.atLimit === false) return "limit";
  return null;
}

const FULL_PERCENT = 100;
const CHOICE_REQUIRED = "RESET_CHOICE_REQUIRED";
const REFUSAL_CODE = /^RESET_(?:BLOCKED_)?([A-Z_]+)$/;
const CODENAME = /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/;

const OPTION_ORDER: readonly ResetFamily[] = ["full", "weekly", "five_hour", "scoped", "other"];
const NAMED_REFILLS: Record<ResetFamily, readonly ResetLimit["family"][]> = {
  five_hour: ["five_hour"],
  weekly: ["weekly"],
  full: ["five_hour", "weekly"],
  scoped: ["scoped"],
  other: [],
};
const LIMIT_ORDER: readonly ResetLimit["family"][] = ["five_hour", "weekly", "scoped", "other"];
const BLOCKERS: readonly ResetBlocker[] = [
  "ineligible",
  "cooldown",
  "paused",
  "not_started",
  "not_usable",
  "exhausted",
  "needs_limit",
  "other_limit",
  "nothing_to_give_back",
  "pending",
];

export type ResetNaming = { family: ResetFamily; scope: string };

export type LimitNaming = { family: ResetLimit["family"]; scope: string };

export type LimitEffect = { limit: ResetLimit; before: number | null; after: number | null };

export type ResetEffects = {
  refills: LimitEffect[];
  givesBack: { scope: string; percent: number | null; weekly: LimitEffect | null } | null;
  staysFull: ResetLimit[];
};

export type ResetFlow =
  | { mode: "retry" }
  | { mode: "plain" }
  | { mode: "choose"; options: ResetOption[]; initial: string | null }
  | { mode: "review"; option: ResetOption };

export type ResetStart = { picked: string | null; review: string | null };

export type ResetRefusal = { kind: "choice" } | { kind: "blocker"; blocker: ResetBlocker };

export function isSpendable(option: Pick<ResetOption, "blocker">): boolean {
  return option.blocker === null;
}

function optionRank(option: ResetOption): number {
  if (!isSpendable(option)) return 3;
  if (option.recommended) return 0;
  return option.helpsNow ? 1 : 2;
}

function expiryOf(option: ResetOption): number {
  const at = option.expiresAt ? Date.parse(option.expiresAt) : NaN;
  return Number.isFinite(at) ? at : Infinity;
}

function byText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function orderResetOptions(options: readonly ResetOption[]): ResetOption[] {
  return [...options].sort((a, b) => {
    const rank = optionRank(a) - optionRank(b);
    if (rank !== 0) return rank;
    const family = OPTION_ORDER.indexOf(a.family) - OPTION_ORDER.indexOf(b.family);
    if (family !== 0) return family;
    const left = expiryOf(a);
    const right = expiryOf(b);
    if (left !== right) return left < right ? -1 : 1;
    return byText(a.id, b.id);
  });
}

export function resetOptions(credits: ResetCredits): ResetOption[] {
  return orderResetOptions(credits.options ?? []);
}

export function defaultResetOption(options: readonly ResetOption[]): ResetOption | null {
  const open = options.filter(isSpendable);
  return open.find((option) => option.recommended) ?? (open.length === 1 ? open[0]! : null);
}

export function recommendedReset(credits: ResetCredits): ResetOption | null {
  if (credits.pending) return null;
  return (credits.options ?? []).find((option) => option.recommended && isSpendable(option)) ?? null;
}

export function resetFlow(credits: ResetCredits): ResetFlow {
  if (credits.pending) return credits.pending.retryable ? { mode: "retry" } : { mode: "plain" };
  const options = resetOptions(credits);
  if (options.length === 0) return { mode: "plain" };
  if (options.length === 1) return { mode: "review", option: options[0]! };
  return { mode: "choose", options, initial: defaultResetOption(options)?.id ?? null };
}

export function resetStart(flow: ResetFlow, optionId: string | null = null): ResetStart {
  if (flow.mode === "review") return { picked: null, review: flow.option.id };
  if (flow.mode !== "choose" || !optionId) return { picked: null, review: null };
  const chosen = flow.options.find((option) => option.id === optionId && isSpendable(option));
  return chosen ? { picked: chosen.id, review: chosen.id } : { picked: null, review: null };
}

export function optionNaming(option: Pick<ResetOption, "family" | "scope">): ResetNaming {
  const scope = option.scope.trim();
  if (option.family !== "scoped") return { family: option.family, scope: "" };
  return scope ? { family: "scoped", scope } : { family: "other", scope: "" };
}

export function limitNaming(limit: Pick<ResetLimit, "family" | "scope">): LimitNaming {
  const scope = limit.scope.trim();
  if (limit.family !== "scoped") return { family: limit.family, scope: "" };
  return scope ? { family: "scoped", scope } : { family: "other", scope: "" };
}

export function upstreamLabel(option: Pick<ResetOption, "label">): string {
  const label = option.label.trim();
  return CODENAME.test(label) ? "" : label;
}

export function isFullLimit(limit: Pick<ResetLimit, "usedPercent" | "limitReached">): boolean {
  return limit.limitReached || (limit.usedPercent ?? 0) >= FULL_PERCENT;
}

function percentOf(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(FULL_PERCENT, Math.max(0, value));
}

function usedBefore(limit: ResetLimit): number | null {
  const used = percentOf(limit.usedPercent);
  return used === null && limit.limitReached ? FULL_PERCENT : used;
}

function byLimitOrder(a: ResetLimit, b: ResetLimit): number {
  const family = LIMIT_ORDER.indexOf(a.family) - LIMIT_ORDER.indexOf(b.family);
  return family !== 0 ? family : byText(a.scope, b.scope) || byText(a.key, b.key);
}

export function resetEffects(option: ResetOption, limits: readonly ResetLimit[]): ResetEffects {
  const refilled = new Set(option.refills.map((limit) => limit.key));
  const refills = [...option.refills]
    .sort(byLimitOrder)
    .map((limit) => ({ limit, before: usedBefore(limit), after: 0 }));
  const weekly = limits.find((limit) => limit.family === "weekly" && !refilled.has(limit.key)) ?? null;
  const percent = option.givesBack ? percentOf(option.givesBack.percentOfWeekly) : null;
  const weeklyBefore = weekly ? usedBefore(weekly) : null;
  const returned: LimitEffect | null =
    option.givesBack && weekly
      ? {
          limit: weekly,
          before: weeklyBefore,
          after: weeklyBefore !== null && percent !== null ? Math.max(0, weeklyBefore - percent) : null,
        }
      : null;
  const eased = returned !== null && (returned.after === null || returned.after < FULL_PERCENT);
  const staysFull = limits
    .filter((limit) => isFullLimit(limit) && !refilled.has(limit.key) && !(eased && limit.key === returned.limit.key))
    .sort(byLimitOrder);
  return {
    refills,
    givesBack: option.givesBack ? { scope: option.givesBack.scope.trim(), percent, weekly: returned } : null,
    staysFull,
  };
}

export function alsoRefills(option: Pick<ResetOption, "family" | "scope" | "refills">): ResetLimit[] {
  const named = NAMED_REFILLS[optionNaming(option).family];
  return option.refills
    .filter((limit) => {
      const family = limitNaming(limit).family;
      return family !== "other" && !named.includes(family);
    })
    .sort(byLimitOrder);
}

export function leftAfterUse(option: Pick<ResetOption, "left">): number {
  return Math.max(0, option.left - 1);
}

export function resetRefusal(code: string): ResetRefusal | null {
  if (code === CHOICE_REQUIRED) return { kind: "choice" };
  const name = REFUSAL_CODE.exec(code)?.[1]?.toLowerCase();
  const blocker = BLOCKERS.find((item) => item === name);
  return blocker ? { kind: "blocker", blocker } : null;
}
