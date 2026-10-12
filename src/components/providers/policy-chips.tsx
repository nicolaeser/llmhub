"use client";

import { Chip } from "@heroui/react";
import { useTranslations } from "next-intl";
import type { ProviderPolicyInput } from "@/types/providers";

export default function PolicyChips({ policy }: { policy: ProviderPolicyInput }) {
  const t = useTranslations("Providers");
  return (
    <>
      {policy.zdr ? (
        <Chip size="sm" variant="soft" color="success">
          {t("policy.zdrChip")}
        </Chip>
      ) : null}
      {policy.region ? (
        <Chip size="sm" variant="soft">
          {t("policy.regionOption", { region: policy.region })}
        </Chip>
      ) : null}
      {!policy.zdr && policy.retentionDays !== null ? (
        <Chip size="sm" variant="soft">
          {t("policy.retentionChip", { days: policy.retentionDays })}
        </Chip>
      ) : null}
      {!policy.zdr && policy.noTraining ? (
        <Chip size="sm" variant="soft">
          {t("policy.noTrainingChip")}
        </Chip>
      ) : null}
    </>
  );
}
