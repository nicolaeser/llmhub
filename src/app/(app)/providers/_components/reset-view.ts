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

export type ResetChoice = {
  id: string;
  kind: "credit" | "grant";
  title: string;
  expiresAt: string | null;
  left: number;
  total: number;
};

export function resetChoices(credits: ResetCredits): ResetChoice[] {
  if (credits.pending) return [];
  const listed: ResetChoice[] = [
    ...(credits.credits ?? []).map((credit) => ({
      id: credit.id,
      kind: "credit" as const,
      title: credit.title,
      expiresAt: credit.expiresAt,
      left: 1,
      total: 1,
    })),
    ...(credits.grants ?? [])
      .filter((grant) => grant.usable)
      .map((grant) => ({
        id: grant.id,
        kind: "grant" as const,
        title: grant.label,
        expiresAt: grant.endsAt,
        left: grant.resetsLeft,
        total: grant.resetsTotal,
      })),
  ];
  return listed.length > 1 ? listed : [];
}
