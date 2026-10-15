"use client";

import { Chip } from "@heroui/react";
import { useTranslations } from "next-intl";

const CHIP = "whitespace-nowrap";

export default function SubscriptionBadge() {
  const t = useTranslations("Providers");
  return (
    <Chip size="sm" variant="soft" color="accent" className={CHIP} title={t("poolHint", { pool: "subscription" })}>
      {t("pool", { pool: "subscription" })}
    </Chip>
  );
}

export function PlanBadge({ plan }: { plan: string }) {
  const t = useTranslations("Providers");
  if (!plan) return null;
  return (
    <Chip size="sm" variant="primary" color="accent" className={CHIP}>
      {t("signIn.plan", { plan })}
    </Chip>
  );
}
