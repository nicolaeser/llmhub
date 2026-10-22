"use client";

import { Card } from "@heroui/react";
import { useTranslations } from "next-intl";
import TimeZonePicker from "@/components/console/time-zone-picker";
import { setConsoleTimeZone, useConsoleTimeZone } from "@/lib/hooks/use-console-time-zone";

export default function PreferencesCard() {
  const t = useTranslations("Account.preferences");
  const timeZone = useConsoleTimeZone();

  return (
    <Card className="gap-4">
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>{t("description")}</Card.Description>
      </Card.Header>
      <Card.Content>
        <TimeZonePicker
          label={t("timeZone")}
          description={t("timeZoneHint")}
          value={timeZone}
          isDisabled={false}
          onChange={setConsoleTimeZone}
        />
      </Card.Content>
    </Card>
  );
}
