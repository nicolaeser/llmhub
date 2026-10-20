import { latestRecovery, quotaExhausted } from "@/lib/gateway/routing/quota";
import type { AccountLimits, AccountState, ProviderView } from "@/types/providers";

export const ACCOUNT_STATE_COLOR = {
  paused: "default",
  available: "success",
  limited: "warning",
  expired: "danger",
  unavailable: "warning",
  checking: "default",
  connected: "success",
} as const satisfies Record<AccountState, "success" | "danger" | "warning" | "default">;

export function accountState(row: ProviderView, entry: AccountLimits | undefined, reports: boolean): AccountState {
  if (!row.enabled) return "paused";
  if (row.signIn?.status !== "active") return "expired";
  if (!reports) return "connected";
  if (!entry) return "checking";
  if (entry.error === "SIGN_IN_EXPIRED") return "expired";
  if (!entry.limits) return "unavailable";
  return quotaExhausted(entry.limits, "") ? "limited" : "available";
}

export function recoveryAt(entry: AccountLimits | undefined, now = Date.now()): number | null {
  return entry?.limits ? latestRecovery(entry.limits, now) : null;
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
