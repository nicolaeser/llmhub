"use client";

import { Chip } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import type { HeldPause, PauseScope } from "@/types/structure";

export default function PauseChip({ pause, own }: { pause: HeldPause; own: PauseScope }) {
  const t = useTranslations("Common.pause");
  const format = useFormatter();
  return (
    <Chip size="sm" variant="soft" color="warning">
      {t("state", {
        scope: pause.scope === own ? "own" : pause.scope,
        timed: pause.until ? "yes" : "no",
        until: pause.until ? format.dateTime(new Date(pause.until), "stamp") : "",
      })}
    </Chip>
  );
}
