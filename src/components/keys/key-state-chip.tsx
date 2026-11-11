"use client";

import { Chip } from "@heroui/react";
import { useTranslations } from "next-intl";
import PauseChip from "@/components/console/pause-chip";
import type { KeyState } from "@/lib/keys/pause";
import type { HeldPause } from "@/types/structure";

const STATE_COLOR = {
  active: "success",
  paused: "warning",
  blocked: "danger",
} as const satisfies Record<KeyState, "success" | "warning" | "danger">;

export default function KeyStateChip({ state, pause }: { state: KeyState; pause: HeldPause | null }) {
  const t = useTranslations("Keys");
  if (state === "paused" && pause) return <PauseChip pause={pause} own="key" />;
  return (
    <Chip size="sm" variant="soft" color={STATE_COLOR[state]}>
      {t("state", { state })}
    </Chip>
  );
}
