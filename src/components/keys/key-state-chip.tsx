"use client";

import { Chip } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import type { KeyState } from "@/lib/keys/pause";

const STATE_COLOR = {
  active: "success",
  paused: "warning",
  blocked: "danger",
} as const satisfies Record<KeyState, "success" | "warning" | "danger">;

export default function KeyStateChip({ state, pausedUntil }: { state: KeyState; pausedUntil: string }) {
  const t = useTranslations("Keys");
  const format = useFormatter();
  return (
    <Chip size="sm" variant="soft" color={STATE_COLOR[state]}>
      {t("state", {
        state,
        timed: pausedUntil ? "yes" : "no",
        until: pausedUntil ? format.dateTime(new Date(pausedUntil), "stamp") : "",
      })}
    </Chip>
  );
}
