import type { ProviderView } from "@/types/providers";
import type { ResetCredits } from "@/types/resets";

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
