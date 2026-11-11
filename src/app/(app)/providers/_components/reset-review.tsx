"use client";

import { Alert, Card, Separator } from "@heroui/react";
import { CalendarClock, Hourglass, Layers, OctagonAlert, TimerReset } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import type { ResetCredits, ResetOption } from "@/types/resets";
import { ResetEffectRow } from "./reset-limit-bar";
import { ResetOptionChips } from "./reset-option-card";
import { isSpendable, leftAfterUse, resetEffects } from "./reset-view";
import type { ResetLabels } from "./use-reset-labels";

const SECTION_TITLE = "text-sm font-medium text-foreground";
const FACT = "flex items-start gap-2 text-sm text-foreground";
const FACT_ICON = "mt-0.5 shrink-0 text-muted";

export default function ResetReview({
  option,
  credits,
  labels,
}: {
  option: ResetOption;
  credits: ResetCredits;
  labels: ResetLabels;
}) {
  const t = useTranslations("Subscriptions.resets");
  const limits = credits.limits ?? [];
  const effects = resetEffects(option, limits);
  const returned = effects.givesBack?.weekly?.after != null ? effects.givesBack.weekly : null;
  const weekly = [...limits, ...option.refills].find((limit) => limit.family === "weekly");
  const weeklyAt = weekly?.resetsAt ? Date.parse(weekly.resetsAt) : NaN;
  const weeklyDated = Number.isFinite(weeklyAt) && weeklyAt > labels.now;
  const nothing = effects.refills.length === 0 && !returned && effects.staysFull.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <IconTile icon={TimerReset} size="lg" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="break-words text-lg font-semibold text-foreground">{labels.option(option)}</p>
            <ResetOptionChips option={option} />
          </div>
          {option.refills.length > 0 || !option.givesBack ? (
            <p className="text-sm text-muted">{labels.effect(option)}</p>
          ) : null}
          {effects.givesBack ? <p className="text-sm text-muted">{labels.givesBack(effects.givesBack)}</p> : null}
        </div>
      </div>

      {option.blocker ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("option.blocked")}</Alert.Title>
            <Alert.Description>{labels.blocker(option.blocker, option)}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {isSpendable(option) && !option.helpsNow ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("flow.earlyTitle")}</Alert.Title>
            <Alert.Description>{t("flow.earlyBody")}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Card variant="secondary">
        <Card.Content className="space-y-4">
          {effects.refills.length > 0 ? (
            <section className="space-y-3">
              <h3 className={SECTION_TITLE}>{t("flow.refills")}</h3>
              {effects.refills.map((effect) => (
                <ResetEffectRow key={effect.limit.key} effect={effect} name={labels.limit(effect.limit)} />
              ))}
            </section>
          ) : null}
          {returned ? (
            <>
              {effects.refills.length > 0 ? <Separator /> : null}
              <section className="space-y-3">
                <h3 className={SECTION_TITLE}>{t("flow.returns")}</h3>
                <ResetEffectRow effect={returned} name={labels.limit(returned.limit)} />
              </section>
            </>
          ) : null}
          {effects.staysFull.length > 0 ? (
            <>
              {effects.refills.length > 0 || returned ? <Separator /> : null}
              <section className="space-y-2">
                <h3 className={SECTION_TITLE}>{t("flow.staysFull")}</h3>
                <ul className="space-y-1.5">
                  {effects.staysFull.map((limit) => {
                    const at = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
                    const timed = Number.isFinite(at) && at > labels.now;
                    return (
                      <li key={limit.key} className={FACT}>
                        <OctagonAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-danger" />
                        <span className="min-w-0 break-words">
                          {t("flow.staysFullItem", {
                            timed: String(timed),
                            limit: labels.limit(limit),
                            countdown: timed ? labels.reset.countdown(at) : "",
                            date: timed ? labels.reset.date(at) : "",
                          })}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </>
          ) : null}
          {nothing ? <p className="text-sm text-muted">{t("flow.noLimits")}</p> : null}
        </Card.Content>
      </Card>

      <section className="space-y-2">
        <h3 className={SECTION_TITLE}>{t("flow.details")}</h3>
        <ul className="space-y-1.5">
          <li className={FACT}>
            <CalendarClock size={14} aria-hidden className={FACT_ICON} />
            <span className="min-w-0">
              {t("flow.weeklyDay", {
                moves: String(option.movesWeeklyResetDay),
                dated: String(weeklyDated),
                date: weeklyDated ? labels.reset.date(weeklyAt, true) : "",
              })}
            </span>
          </li>
          <li className={FACT}>
            <Layers size={14} aria-hidden className={FACT_ICON} />
            <span className="min-w-0">{t("flow.leftAfter", { left: leftAfterUse(option), total: option.total })}</span>
          </li>
          <li className={FACT}>
            <Hourglass size={14} aria-hidden className={FACT_ICON} />
            <span className="min-w-0">{labels.expires(option)}</span>
          </li>
        </ul>
      </section>

      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content className="min-w-0">
          <Alert.Title>{t("flow.irreversibleTitle")}</Alert.Title>
          <Alert.Description>{t("flow.irreversible")}</Alert.Description>
        </Alert.Content>
      </Alert>
    </div>
  );
}
