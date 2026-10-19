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
