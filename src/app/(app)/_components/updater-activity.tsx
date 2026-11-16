"use client";

import { Alert, Chip, ProgressBar, Spinner } from "@heroui/react";
import {
  Activity,
  ArrowUpCircle,
  CircleCheck,
  CircleCheckBig,
  CircleDashed,
  CircleX,
  Clock,
  Download,
  OctagonAlert,
  Pin,
  RefreshCw,
  Search,
  ShieldCheck,
  Undo2,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { useClock } from "@/lib/hooks/use-clock";
import { formatBytes } from "@/lib/utils/bytes";
import type { Tone } from "@/types/console";
import type { UpdaterState, UpdaterView } from "@/types/updates";
import { useBuildStatus } from "./build-status";
import {
  downloadPercent,
  downloadView,
  elapsedMilliseconds,
  runSteps,
  stopwatch,
  updaterSummary,
  type StepState,
  type UpdatePhase,
  type UpdaterSummary,
} from "./updater-history-view";

const SUMMARY_LOOK: Record<Exclude<UpdaterSummary, "running">, { icon: LucideIcon; tone: Tone }> = {
  offline: { icon: Unplug, tone: "warning" },
  requested: { icon: Clock, tone: "accent" },
  checking: { icon: Search, tone: "accent" },
  recovery: { icon: OctagonAlert, tone: "danger" },
  failed: { icon: CircleX, tone: "danger" },
  rolled_back: { icon: Undo2, tone: "warning" },
  installed: { icon: CircleCheckBig, tone: "success" },
  pinned: { icon: Pin, tone: "neutral" },
  available: { icon: ArrowUpCircle, tone: "accent" },
  current: { icon: ShieldCheck, tone: "success" },
};

const RUNNING_ICONS: Record<UpdaterState, LucideIcon> = {
  idle: Activity,
  checking: Search,
  pulling: Download,
  recreating: RefreshCw,
  verifying: Activity,
  rolling_back: Undo2,
  failed: CircleX,
};

function StepMark({ state, rollback }: { state: StepState; rollback: boolean }) {
  return (
    <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
      {state === "done" ? <CircleCheck size={16} className="text-success" /> : null}
      {state === "active" ? <Spinner size="sm" color={rollback ? "warning" : "accent"} /> : null}
      {state === "waiting" ? <CircleDashed size={16} className="text-muted" /> : null}
    </span>
  );
}

function StepDetail({ updater, phase }: { updater: UpdaterView; phase: UpdatePhase }) {
  const t = useTranslations("Common.updater");
  const format = useFormatter();
  const progress = updater.progress;
  if (!progress) return null;

  if (phase === "pulling") {
    const download = progress.download ? downloadView(progress.download) : null;
    const percent = download ? downloadPercent(download) : null;
    return (
      <div className="space-y-1.5">
        <ProgressBar
          size="sm"
          aria-label={t("step", { phase })}
          value={percent ?? undefined}
          isIndeterminate={percent === null}
        >
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
        <p className="flex flex-wrap justify-between gap-x-3 text-xs tabular-nums text-muted">
          <span>
            {download
              ? t("downloadBytes", {
                  known: String(download.totalBytes !== null),
                  downloaded: formatBytes(format, download.downloadedBytes),
                  total: download.totalBytes === null ? "" : formatBytes(format, download.totalBytes),
                })
              : t("downloadStarting")}
          </span>
          {download && download.layersTotal > 0 ? (
            <span>{t("downloadLayers", { completed: download.layersCompleted, total: download.layersTotal })}</span>
          ) : null}
        </p>
      </div>
    );
  }

  if (phase === "recreating" || phase === "verifying") {
    const startup = progress.startup === "migrating" || progress.startup === "starting" ? progress.startup : null;
    return (
      <div className="space-y-1.5">
        {progress.total > 0 ? (
          <ProgressBar size="sm" aria-label={t("step", { phase })} value={progress.completed} maxValue={progress.total}>
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        ) : null}
        <p className="flex flex-wrap justify-between gap-x-3 text-xs tabular-nums text-muted">
          {progress.service ? <span className="min-w-0 break-words">{t("service", { service: progress.service })}</span> : null}
          {progress.total > 0 ? (
            <span>{t("serviceProgress", { completed: progress.completed, total: progress.total })}</span>
          ) : null}
        </p>
        {startup ? <p className="text-xs text-muted">{t("startup", { startup })}</p> : null}
      </div>
    );
  }

  return null;
}

function RunSteps({ updater, now }: { updater: UpdaterView; now: number }) {
  const t = useTranslations("Common.updater");
  const rollback = updater.state === "rolling_back";
  const phaseStartedAt = updater.progress?.phaseStartedAt;

  return (
    <ol className="space-y-3" aria-label={t("stepsLabel")}>
      {runSteps(updater.state).map((step) => (
        <li key={step.phase} className="flex gap-3" aria-current={step.state === "active" ? "step" : undefined}>
          <StepMark state={step.state} rollback={rollback} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <span
                className={
                  step.state === "active"
                    ? "text-sm font-medium text-foreground"
                    : step.state === "done"
                      ? "text-sm text-foreground"
                      : "text-sm text-muted"
                }
              >
                {t("step", { phase: step.phase })}
              </span>
              {step.state === "active" && phaseStartedAt ? (
                <span className="text-xs tabular-nums text-muted">{stopwatch(elapsedMilliseconds(phaseStartedAt, now))}</span>
              ) : null}
            </div>
            {step.state === "active" ? <StepDetail updater={updater} phase={step.phase} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function UpdaterActivity({ updater }: { updater: UpdaterView }) {
  const t = useTranslations("Common.updater");
  const format = useFormatter();
  const now = useClock(1_000);
  const build = useBuildStatus();
  const summary = updaterSummary(updater, now.getTime());
  const running = summary === "running";
  const look = running
    ? { icon: RUNNING_ICONS[updater.state], tone: updater.state === "rolling_back" ? "warning" : "accent" } as const
    : SUMMARY_LOOK[summary];
  const when = (iso: string) => format.relativeTime(new Date(iso), now);
  const result = updater.lastResult;
  const startedAt = updater.progress?.startedAt;
  const recovery = updater.progress?.startup === "manual_recovery" || updater.progress?.startup === "migration_failed"
    ? updater.progress.startup
    : null;
  const interrupted = build?.liveConnected === false && (running || summary === "requested");

  const detail = (() => {
    switch (summary) {
      case "offline":
        return updater.seenAt ? t("lastSeen", { when: when(updater.seenAt) }) : t("offlineHint");
      case "requested":
        return t("queued", { action: updater.pending ?? "" });
      case "checking":
      case "running":
        return t("phaseHint", { state: updater.state });
      case "recovery":
        return t("recoveryHint");
      case "failed":
      case "rolled_back":
        return result?.detail ?? t("phaseHint", { state: "failed" });
      case "installed":
        return result ? t("installedAt", { when: when(result.at) }) : "";
      case "pinned":
        return t("pinnedShort", { tag: updater.tag ?? "" });
      default:
        return updater.checkedAt ? t("checkedAt", { when: when(updater.checkedAt) }) : t("never");
    }
  })();

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-start gap-3">
        <IconTile icon={look.icon} tone={look.tone} size="lg" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-semibold text-foreground" role="status" aria-live="polite">
            {running ? t("runTitle", { state: updater.state }) : t("summary", { summary })}
          </p>
          <p className="break-words text-sm text-muted">{detail}</p>
        </div>
        {running && startedAt ? (
          <Chip size="sm" variant="soft">
            <Clock size={12} aria-hidden />
            <span className="tabular-nums">{stopwatch(elapsedMilliseconds(startedAt, now.getTime()))}</span>
          </Chip>
        ) : null}
      </div>
      {running ? <RunSteps updater={updater} now={now.getTime()} /> : null}
      {interrupted ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("staleProgress")}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {recovery ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("startup", { startup: recovery })}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {updater.issue ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("issue", { issue: updater.issue })}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </div>
  );
}
