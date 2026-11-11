"use client";

import { useId } from "react";
import { Card, Chip, Label, Radio } from "@heroui/react";
import { Ban, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ResetOption } from "@/types/resets";
import ResetLimitBar from "./reset-limit-bar";
import { isSpendable, upstreamLabel } from "./reset-view";
import type { ResetLabels } from "./use-reset-labels";

export function ResetOptionChips({ option }: { option: ResetOption }) {
  const t = useTranslations("Subscriptions.resets.option");
  if (!isSpendable(option)) {
    return (
      <Chip size="sm" variant="soft" className="whitespace-nowrap">
        {t("blocked")}
      </Chip>
    );
  }
  return (
    <>
      {option.recommended ? (
        <Chip size="sm" variant="soft" color="accent" className="whitespace-nowrap">
          {t("recommended")}
        </Chip>
      ) : null}
      {option.helpsNow ? (
        <Chip size="sm" variant="soft" color="success" className="whitespace-nowrap">
          {t("helpsNow")}
        </Chip>
      ) : null}
    </>
  );
}

export function ResetOptionNotes({ option, labels }: { option: ResetOption; labels: ResetLabels }) {
  const t = useTranslations("Subscriptions.resets.option");
  return (
    <>
      {option.blocker ? (
        <p className="flex items-start gap-1.5 text-xs text-foreground">
          <Ban size={12} aria-hidden className="mt-0.5 shrink-0 text-muted" />
          {labels.blocker(option.blocker, option)}
        </p>
      ) : null}
      {isSpendable(option) && !option.helpsNow ? (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0" />
          {t("early")}
        </p>
      ) : null}
    </>
  );
}

export default function ResetOptionCard({
  option,
  selected,
  labels,
  autoFocus,
}: {
  option: ResetOption;
  selected: boolean;
  labels: ResetLabels;
  autoFocus: boolean;
}) {
  const t = useTranslations("Subscriptions.resets.option");
  const detailsId = useId();
  const upstream = upstreamLabel(option);

  return (
    <Card
      variant="secondary"
      className={`relative gap-3 p-3 ${selected ? "border border-accent bg-accent/8" : "border border-transparent"}`}
    >
      <Radio
        value={option.id}
        isDisabled={!isSpendable(option)}
        autoFocus={autoFocus}
        aria-describedby={detailsId}
        className="mt-0 w-full"
      >
        <Radio.Content className="static w-full items-start gap-3 after:absolute after:inset-0 after:content-['']">
          <Radio.Control>
            <Radio.Indicator />
          </Radio.Control>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <Label className="break-words">{labels.option(option)}</Label>
            <ResetOptionChips option={option} />
          </span>
        </Radio.Content>
      </Radio>
      <div id={detailsId} className="space-y-3 ps-7">
        <div className="space-y-1 text-xs text-muted">
          {option.refills.length > 0 || !option.givesBack ? <p>{labels.effect(option)}</p> : null}
          {option.givesBack ? (
            <p>{labels.givesBack({ scope: option.givesBack.scope, percent: option.givesBack.percentOfWeekly })}</p>
          ) : null}
        </div>
        {option.refills.length > 0 ? (
          <ul className="space-y-2">
            {option.refills.map((limit) => (
              <li key={limit.key}>
                <ResetLimitBar limit={limit} name={labels.limit(limit)} />
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted">
          {labels.left(option)} · {labels.expiry(option)}
        </p>
        {upstream ? <p className="break-words text-xs text-muted">{t("upstream", { label: upstream })}</p> : null}
        <ResetOptionNotes option={option} labels={labels} />
      </div>
    </Card>
  );
}
