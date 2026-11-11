"use client";

import { useTranslations } from "next-intl";
import type { ResetBlocker, ResetCredits, ResetLimit, ResetOption } from "@/types/resets";
import { limitNaming, optionNaming } from "./reset-view";
import { useResetTime } from "./use-reset-time";

export function useResetLabels(timeZone: string, credits: Pick<ResetCredits, "cooldownUntil">) {
  const t = useTranslations("Subscriptions.resets");
  const reset = useResetTime(timeZone);
  const now = reset.now.getTime();
  const cooldown = credits.cooldownUntil ? Date.parse(credits.cooldownUntil) : NaN;
  const cooling = Number.isFinite(cooldown) && cooldown > now;

  function expiry(option: Pick<ResetOption, "expiresAt">) {
    const at = option.expiresAt ? Date.parse(option.expiresAt) : NaN;
    const dated = Number.isFinite(at);
    return { dated: String(dated), date: dated ? reset.date(at, true) : "" };
  }

  return {
    reset,
    now,
    option: (option: Pick<ResetOption, "family" | "scope">) => t("option.name", optionNaming(option)),
    effect: (option: Pick<ResetOption, "family" | "scope">) => t("option.effect", optionNaming(option)),
    confirm: (option: Pick<ResetOption, "family" | "scope">) => t("flow.confirm", optionNaming(option)),
    limit: (limit: Pick<ResetLimit, "family" | "scope">) => t("limit.name", limitNaming(limit)),
    alsoRefills: (limit: Pick<ResetLimit, "family" | "scope">) => t("option.alsoRefills", limitNaming(limit)),
    staysFull: (limit: Pick<ResetLimit, "family" | "scope">) => t("option.staysFull", limitNaming(limit)),
    left: (option: Pick<ResetOption, "left" | "total">) => t("option.left", { left: option.left, total: option.total }),
    expiry: (option: Pick<ResetOption, "expiresAt">) => t("option.expiry", expiry(option)),
    expires: (option: Pick<ResetOption, "expiresAt">) => t("flow.expires", expiry(option)),
    givesBack: (given: { scope: string; percent: number | null }) =>
      t("option.givesBack", {
        known: String(given.percent !== null),
        scope: given.scope,
        percent: (given.percent ?? 0) / 100,
      }),
    blocker: (blocker: ResetBlocker, option: Pick<ResetOption, "scope" | "givesBack" | "blockedBy"> | null) => {
      const scope = (option?.givesBack?.scope ?? option?.scope ?? "").trim();
      const blockedBy = option?.blockedBy ? limitNaming(option.blockedBy) : null;
      return t("option.blocker", {
        blocker,
        named: String(scope !== ""),
        scope,
        limit: blockedBy?.family ?? "other",
        limitScope: blockedBy?.scope ?? "",
        timed: String(cooling),
        when: cooling ? reset.countdown(cooldown) : "",
        date: cooling ? reset.date(cooldown) : "",
      });
    },
  };
}

export type ResetLabels = ReturnType<typeof useResetLabels>;
