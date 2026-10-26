"use client";

import { Chip } from "@heroui/react";
import { useTranslations } from "next-intl";
import type { RequestLabel } from "@/types/usage";

export default function LabelChips({ labels }: { labels: RequestLabel[] }) {
  const t = useTranslations("Logs");
  if (!labels.length) return null;
  return (
    <ul aria-label={t("labels.title")} className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <li key={label.key} className="min-w-0">
          <Chip size="sm" variant="soft" className="max-w-full">
            <span className="break-all">{t("labels.chip", { key: label.key, value: label.value })}</span>
          </Chip>
        </li>
      ))}
    </ul>
  );
}
