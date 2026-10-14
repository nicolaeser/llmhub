"use client";

import { Badge } from "@heroui/react";
import { useTranslations } from "next-intl";

const BADGE = "px-1.5 whitespace-nowrap";

export default function SubscriptionBadge() {
  const t = useTranslations("Providers");
  return (
    <Badge size="sm" variant="soft" color="accent" className={BADGE} title={t("poolHint", { pool: "subscription" })}>
      {t("pool", { pool: "subscription" })}
    </Badge>
  );
}

export function PlanBadge({ plan }: { plan: string }) {
  const t = useTranslations("Providers");
  if (!plan) return null;
  return (
    <Badge size="sm" variant="primary" color="accent" className={BADGE}>
      {t("signIn.plan", { plan })}
    </Badge>
  );
}
