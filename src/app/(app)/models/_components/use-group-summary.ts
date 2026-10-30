"use client";

import { useFormatter, useTranslations } from "next-intl";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import type { ProviderOpt } from "@/types/models";
import { groupSummary, type GroupSummary, type GroupSummaryInput, type SummaryRoute } from "./group-summary";

export type GroupSummaryText = { summary: GroupSummary; sentence: string; pricing: string | null };

export function useRouteName(providers: readonly ProviderOpt[]): (route: SummaryRoute) => string {
  const tProviders = useTranslations("Providers");
  return (route) => {
    const provider = route.providerId ? providers.find((item) => item.id === route.providerId) : undefined;
    if (provider) return provider.name;
    const kind = route.kind.startsWith("kind:") ? route.kind.slice(5) : route.kind;
    return tProviders(isSignInKind(kind) ? "kindShort" : "kindName", { kind });
  };
}

export function useGroupSummary(
  providers: readonly ProviderOpt[],
): (group: GroupSummaryInput & { priceInput: number; priceOutput: number; priceWindows: number }) => GroupSummaryText {
  const t = useTranslations("Models");
  const format = useFormatter();
  const nameOf = useRouteName(providers);
  return (group) => {
    const summary = groupSummary(group, nameOf);
    const sentence = t("summary", {
      spread: summary.spread,
      endpoints: summary.endpoints,
      targets: format.list(summary.targets, { type: "conjunction" }),
      strategy: summary.strategy,
      fallback: summary.fallbacks.length ? "some" : "none",
      fallbacks: format.list(summary.fallbacks, { type: "unit" }),
      overflow: summary.overflow ? "some" : "none",
      overflowModel: summary.overflow,
    });
    const pricing =
      summary.billing === "routed"
        ? null
        : t("billingSummary", {
            mode: summary.billing,
            input: group.priceInput,
            output: group.priceOutput,
            windows: group.priceWindows,
          });
    return { summary, sentence, pricing };
  };
}
