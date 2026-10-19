"use client";

import { Card, Radio, RadioGroup } from "@heroui/react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { kindIcon } from "@/components/providers/kind-icons";
import type { SignInKind } from "@/types/providers";

export default function KindPicker({
  kinds,
  value,
  isDisabled,
  onChange,
}: {
  kinds: SignInKind[];
  value: SignInKind | null;
  isDisabled: boolean;
  onChange: (kind: SignInKind) => void;
}) {
  const t = useTranslations("SubAdd");
  const tProviders = useTranslations("Providers");
  return (
    <RadioGroup
      value={value ?? ""}
      onChange={(next) => {
        const kind = kinds.find((item) => item === next);
        if (kind) onChange(kind);
      }}
      isDisabled={isDisabled}
      aria-label={t("pickLabel")}
      className="grid gap-2 sm:grid-cols-2"
    >
      {kinds.map((kind) => {
        const selected = value === kind;
        return (
          <Card
            key={kind}
            variant="secondary"
            className={selected ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}
          >
            <Radio value={kind} className="mt-0 h-full w-full">
              <Radio.Content className="h-full w-full items-start gap-3 p-3">
                <IconTile icon={kindIcon(kind)} tone={selected ? "accent" : "neutral"} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium break-words">{tProviders("kindShort", { kind })}</span>
                  <span className="mt-0.5 block text-xs text-muted">{t("kindPlan", { kind })}</span>
                </span>
                <Radio.Control>
                  <Radio.Indicator />
                </Radio.Control>
              </Radio.Content>
            </Radio>
          </Card>
        );
      })}
    </RadioGroup>
  );
}
