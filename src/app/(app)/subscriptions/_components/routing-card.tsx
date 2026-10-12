"use client";

import { Card } from "@heroui/react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";

const STRATEGIES = ["quota_balanced", "quota_expiring", "round_robin", "priority"] as const;

export default function RoutingCard() {
  const t = useTranslations("Subscriptions.routing");
  const tModels = useTranslations("Models");

  return (
    <Card variant="secondary">
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>{t("description")}</Card.Description>
      </Card.Header>
      <Card.Content>
        <dl className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {STRATEGIES.map((strategy) => (
            <div key={strategy} className="space-y-1">
              <dt className="text-sm font-medium text-foreground">{tModels(`strategies.${strategy}`)}</dt>
              <dd className="text-sm text-muted">{tModels("strategyHint", { strategy })}</dd>
            </div>
          ))}
        </dl>
      </Card.Content>
      <Card.Footer>
        <Link href="/models" className="text-sm font-medium text-accent">
          {t("openModels")}
        </Link>
      </Card.Footer>
    </Card>
  );
}
