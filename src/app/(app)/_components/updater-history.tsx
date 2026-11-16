"use client";

import { Chip, Disclosure } from "@heroui/react";
import { ArrowUpCircle, CircleCheck, CircleX, History, Pin, ShieldCheck, Undo2, type LucideIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { useClock } from "@/lib/hooks/use-clock";
import type { Tone } from "@/types/console";
import type { UpdaterReport, UpdaterView } from "@/types/updates";
import { durationParts, elapsedMilliseconds, recentUpdateRuns, UPDATE_PHASES } from "./updater-history-view";

type Outcome = NonNullable<UpdaterReport["lastResult"]>["outcome"];

const OUTCOME_LOOK: Record<Outcome, { icon: LucideIcon; tone: Tone }> = {
  updated: { icon: CircleCheck, tone: "success" },
  up_to_date: { icon: ShieldCheck, tone: "neutral" },
  available: { icon: ArrowUpCircle, tone: "accent" },
  rolled_back: { icon: Undo2, tone: "warning" },
  failed: { icon: CircleX, tone: "danger" },
  pinned: { icon: Pin, tone: "neutral" },
};

export default function UpdaterHistory({ updater }: { updater: UpdaterView }) {
  const t = useTranslations("Common.updater");
  const format = useFormatter();
  const now = useClock(10_000);
  const runs = recentUpdateRuns(updater.history);
  const duration = (milliseconds: number) => t("duration", durationParts(milliseconds));

  return (
    <Disclosure>
      <Disclosure.Heading>
        <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
          <span className="flex min-w-0 items-center gap-2">
            <History size={14} aria-hidden className="shrink-0 text-muted" />
            {t("historyTitle")}
            {runs.length > 0 ? (
              <Chip size="sm" variant="soft">
                {format.number(runs.length, "integer")}
              </Chip>
            ) : null}
          </span>
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body>
          {runs.length === 0 ? (
            <p className="text-sm text-muted">{t("historyEmpty")}</p>
          ) : (
            <ol className="min-w-0 divide-y divide-border">
              {runs.map((run) => {
                const look = OUTCOME_LOOK[run.outcome];
                const phases = UPDATE_PHASES.filter((phase) => run.phases[phase] > 0).map((phase) =>
                  t("phaseTook", { phase, duration: duration(run.phases[phase]) }),
                );
                return (
                  <li key={run.id} className="flex min-w-0 gap-3 py-3">
                    <IconTile icon={look.icon} tone={look.tone} size="sm" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-sm font-medium text-foreground">{t("outcome", { outcome: run.outcome })}</span>
                        <time
                          dateTime={run.finishedAt}
                          title={format.dateTime(new Date(run.finishedAt), { dateStyle: "medium", timeStyle: "medium" })}
                          className="text-xs text-muted"
                        >
                          {format.relativeTime(new Date(run.finishedAt), now)}
                        </time>
                      </div>
                      <p className="flex flex-wrap gap-x-3 text-xs tabular-nums text-muted">
                        <span>{t("runTook", { duration: duration(elapsedMilliseconds(run.startedAt, run.finishedAt)) })}</span>
                        {run.services.length > 0 ? (
                          <span className="min-w-0 break-words">{t("runServices", { services: format.list(run.services) })}</span>
                        ) : null}
                      </p>
                      {phases.length > 0 ? (
                        <p className="break-words text-xs tabular-nums text-muted">
                          {format.list(phases, { type: "unit", style: "short" })}
                        </p>
                      ) : null}
                      {run.detail ? (
                        <p className={`break-words text-xs ${run.outcome === "failed" ? "text-danger" : "text-muted"}`}>{run.detail}</p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
