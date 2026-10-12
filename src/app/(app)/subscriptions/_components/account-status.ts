import { earliestRecovery, quotaExhausted } from "@/lib/gateway/routing/quota";
import type { AccountLimits, AccountState, ProviderView } from "@/types/providers";

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
  return entry?.limits ? earliestRecovery(entry.limits, now) : null;
}
