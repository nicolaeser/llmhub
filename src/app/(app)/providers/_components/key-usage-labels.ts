"use client";

import { useFormatter, useTranslations } from "next-intl";
import type { UsageKeyLabel } from "@/types/providers";
import type { BarSegment } from "./key-usage-view";

const FULL_PERCENT = 100;
const FINE_BELOW_PERCENT = 10;

export type KeyName = { label: string; detail: string };

export type SegmentNamer = (segment: BarSegment) => string;

export function useKeyName(): (keyId: string, keys: Record<string, UsageKeyLabel>) => KeyName {
  const t = useTranslations("Subscriptions.keyUsage");
  return (keyId, keys) => {
    if (!keyId) return { label: t("noKey"), detail: t("noKeyHint") };
    const key = keys[keyId];
    if (!key) return { label: t("deletedKey"), detail: "" };
    return { label: key.label, detail: [key.company, key.owner].filter(Boolean).join(" · ") };
  };
}

export function useSegmentName(keys: Record<string, UsageKeyLabel>, short = false): SegmentNamer {
  const t = useTranslations("Subscriptions.keyUsage");
  const keyName = useKeyName();
  return (segment) => {
    if (segment.kind === "other") return t("otherKeys", { count: segment.keyIds.length });
    if (segment.kind === "outside") return short ? t("outsideShort") : t("outside");
    return keyName(segment.id, keys).label;
  };
}

export function useUsagePercent(): (value: number) => string {
  const format = useFormatter();
  return (value) =>
    format.number(value / FULL_PERCENT, {
      style: "percent",
      maximumFractionDigits: value > 0 && value < FINE_BELOW_PERCENT ? 1 : 0,
    });
}
