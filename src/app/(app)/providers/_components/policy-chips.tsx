"use client";

import type { ReactNode } from "react";
import { Chip } from "@heroui/react";
import { useTranslations } from "next-intl";
import type { ProviderPolicyInput } from "@/types/providers";

const CHIP = "whitespace-nowrap";

export default function PolicyChips({
  policy,
  lead,
  fallback = null,
}: {
  policy: ProviderPolicyInput;
  lead?: ReactNode;
  fallback?: ReactNode;
}) {
  const t = useTranslations("Providers");
  const items = [
    policy.zdr ? { key: "zdr", color: "success" as const, label: t("policy.zdrChip") } : null,
    policy.region
      ? { key: "region", color: "default" as const, label: t("policy.regionOption", { region: policy.region }) }
      : null,
    !policy.zdr && policy.retentionDays !== null
      ? {
          key: "retention",
          color: "default" as const,
          label: t("policy.retentionChip", { days: policy.retentionDays }),
        }
      : null,
    !policy.zdr && policy.noTraining
      ? { key: "training", color: "default" as const, label: t("policy.noTrainingChip") }
      : null,
  ].filter((item) => item !== null);

  if (!items.length && !lead) return fallback;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {lead}
      {items.map((item) => (
        <Chip key={item.key} size="sm" variant="soft" color={item.color} className={CHIP}>
          {item.label}
        </Chip>
      ))}
    </div>
  );
}
