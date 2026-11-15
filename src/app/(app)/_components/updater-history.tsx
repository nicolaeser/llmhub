"use client";

import { Disclosure } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { useClock } from "@/lib/hooks/use-clock";
import type { UpdaterView } from "@/types/updates";
import { elapsedMilliseconds, recentUpdateRuns, UPDATE_PHASES } from "./updater-history-view";

export default function UpdaterHistory({ updater }: { updater: UpdaterView }) {
  const t = useTranslations("Common.updater");
  const format = useFormatter();
  const now = useClock(10_000);
  const runs = recentUpdateRuns(updater.history);

  return (
    <Disclosure>
      <Disclosure.Heading>
        <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm">
          {t("historyTitle")}
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body>
          {runs.length === 0 ? <p className="text-sm text-muted">{t("historyEmpty")}</p> : (
            <ol className="min-w-0 space-y-4">
              {runs.map((run) => (
                <li key={run.id} className="min-w-0 space-y-2 text-sm">
                  <p className={run.outcome === "failed" ? "text-danger" : run.outcome === "rolled_back" ? "text-warning" : "text-foreground"}>
                    {t("outcome", { outcome: run.outcome, when: format.relativeTime(new Date(run.finishedAt), now) })}
                  </p>
                  <p className="text-xs tabular-nums text-muted">
                    {t("runTiming", {
                      started: format.dateTime(new Date(run.startedAt), { dateStyle: "medium", timeStyle: "medium" }),
                      duration: elapsedMilliseconds(run.startedAt, run.finishedAt) / 1_000,
                    })}
                  </p>
                  {run.services.length > 0 ? <p className="break-words">{t("runServices", { services: format.list(run.services) })}</p> : null}
                  {run.detail ? <p className="break-words text-muted">{run.detail}</p> : null}
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                    {UPDATE_PHASES.map((phase) => (
                      <div key={phase} className="flex flex-wrap justify-between gap-x-2">
                        <dt className="text-muted">{t("state", { state: phase })}</dt>
                        <dd className="tabular-nums">{t("phaseDuration", { seconds: run.phases[phase] / 1_000 })}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ol>
          )}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
