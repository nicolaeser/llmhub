"use client";

import { buttonVariants, Card, Label, ProgressBar } from "@heroui/react";
import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { Link } from "@/i18n/routing";
import type { UpdaterView } from "@/types/updates";
import { useBuildStatus } from "../../_components/build-status";
import { useConsoleScope } from "../../_components/console-scope";
import { RunClock, useUpdaterHeadline } from "../../_components/updater-activity";
import { UpdaterButtons } from "../../_components/updater-controls";
import { runProgress, summaryNotable } from "../../_components/updater-history-view";
import { UPDATES_HREF } from "../../_components/updater-panel";

function UpdateBanner({
  updater,
  canManage,
  onView,
  withDetails,
}: {
  updater: UpdaterView;
  canManage: boolean;
  onView: (view: UpdaterView | null) => void;
  withDetails: boolean;
}) {
  const t = useTranslations("Common.updater");
  const { summary, look, title, detail, elapsed } = useUpdaterHeadline(updater);
  if (!summaryNotable(summary)) return null;
  const run = runProgress(updater);

  return (
    <Card render={(props) => <section {...props} />} aria-label={t("dashboardTitle")} className="gap-4">
      <Card.Content className="space-y-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <IconTile icon={look.icon} tone={look.tone} size="lg" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-semibold text-foreground" role="status" aria-live="polite">
                {title}
              </p>
              <p className="break-words text-sm text-muted">{detail}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            {elapsed ? <RunClock elapsed={elapsed} /> : null}
            {canManage && summary === "available" ? <UpdaterButtons updater={updater} onView={onView} size="sm" /> : null}
            {withDetails ? (
              <Link href={UPDATES_HREF} className={buttonVariants({ size: "sm", variant: "ghost" })}>
                {t("details")}
                <ArrowRight size={14} aria-hidden />
              </Link>
            ) : null}
          </div>
        </div>
        {run ? (
          <ProgressBar size="sm" value={run.percent} color={updater.state === "rolling_back" ? "warning" : "accent"}>
            <Label>{t("runStep", { step: run.step, steps: run.steps })}</Label>
            <ProgressBar.Output />
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        ) : null}
      </Card.Content>
    </Card>
  );
}

export default function UpdateStatus() {
  const build = useBuildStatus();
  const { kind } = useConsoleScope();
  const live = build?.live;
  if (!build || !live?.canRead || !live.updater) return null;
  return (
    <UpdateBanner
      updater={live.updater}
      canManage={live.canManage}
      onView={build.setUpdater}
      withDetails={kind === "platform"}
    />
  );
}
