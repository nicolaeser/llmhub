import { latestRecovery, quotaExhausted } from "@/lib/gateway/routing/quota";
import { limitGroups } from "@/lib/gateway/upstreams/limit-groups";
import type {
  AccountLimits,
  AccountState,
  LimitGroup,
  PartialLimits,
  ProviderView,
  SubscriptionLimits,
} from "@/types/providers";

export const ACCOUNT_STATE_COLOR = {
  paused: "default",
  available: "success",
  limited: "warning",
  expired: "danger",
  unavailable: "warning",
  checking: "default",
  connected: "success",
} as const satisfies Record<AccountState, "success" | "danger" | "warning" | "default">;

function everyGroupExhausted(groups: LimitGroup[]): boolean {
  return groups.length > 0 && groups.every((group) => group.scoped && group.exhausted);
}

function exhaustedGroups(row: ProviderView, limits: SubscriptionLimits, now: number): LimitGroup[] | null {
  const groups = limitGroups(row.kind, limits, now);
  return everyGroupExhausted(groups) ? groups : null;
}

function latestReset(groups: LimitGroup[]): number | null {
  const resets = groups.flatMap((group) => group.members.map((member) => (member.resetsAt ? Date.parse(member.resetsAt) : NaN)));
  if (resets.some((time) => !Number.isFinite(time))) return null;
  return Math.max(...resets);
}

export function accountState(
  row: ProviderView,
  entry: AccountLimits | undefined,
  reports: boolean,
  now = Date.now(),
): AccountState {
  if (!row.enabled) return "paused";
  if (row.signIn?.status !== "active") return "expired";
  if (!reports) return "connected";
  if (!entry) return "checking";
  if (entry.error === "SIGN_IN_EXPIRED") return "expired";
  if (!entry.limits) return "unavailable";
  return quotaExhausted(entry.limits, "", now) || exhaustedGroups(row, entry.limits, now) ? "limited" : "available";
}

export function recoveryAt(row: ProviderView, entry: AccountLimits | undefined, now = Date.now()): number | null {
  if (!entry?.limits) return null;
  const groups = exhaustedGroups(row, entry.limits, now);
  return groups ? latestReset(groups) : latestRecovery(entry.limits, now);
}

export function partialLimits(row: ProviderView, entry: AccountLimits | undefined, now = Date.now()): PartialLimits | null {
  if (!entry?.limits || quotaExhausted(entry.limits, "", now)) return null;
  const groups = limitGroups(row.kind, entry.limits, now);
  const reached = groups.filter((group) => group.limitReached).length;
  if (!reached || everyGroupExhausted(groups)) return null;
  return { reached, total: groups.length };
}

export const COUNTED_STATES = ["available", "limited", "expired", "paused"] as const satisfies readonly AccountState[];

export type CountedState = (typeof COUNTED_STATES)[number];

export function countedState(state: AccountState): CountedState | null {
  if (state === "connected") return "available";
  return COUNTED_STATES.find((item) => item === state) ?? null;
}

function accountRank(row: ProviderView): number {
  if (!row.enabled) return 2;
  return row.signIn?.status === "active" ? 0 : 1;
}

function accountLabel(row: ProviderView): string {
  return (row.signIn?.account || row.name).toLowerCase();
}

export function byAccountOrder(a: ProviderView, b: ProviderView): number {
  return accountRank(a) - accountRank(b) || accountLabel(a).localeCompare(accountLabel(b)) || a.id.localeCompare(b.id);
}
