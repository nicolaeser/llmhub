"use client";

import { Alert, Chip } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { useClock } from "@/lib/hooks/use-clock";
import { formatBytes } from "@/lib/utils/bytes";
import type { UpdaterState, UpdaterView } from "@/types/updates";
import { useBuildStatus } from "./build-status";
import UpdaterHistory from "./updater-history";
import { downloadView, elapsedMilliseconds } from "./updater-history-view";

const STATE_COLORS: Record<UpdaterState, "default" | "accent" | "warning" | "danger"> = {
  idle: "default",
  checking: "accent",
  pulling: "accent",
  recreating: "accent",
  verifying: "accent",
  rolling_back: "warning",
  failed: "danger",
};

export default function UpdaterActivity({ updater }: { updater: UpdaterView }) {
  const t = useTranslations("Common.updater");
  const format = useFormatter();
  const now = useClock(1_000);
  const build = useBuildStatus();
  const stale = !updater.connected || build?.liveConnected === false;
  const active = updater.state !== "idle" && updater.state !== "failed";
  const progress = active ? updater.progress : null;
  const seconds = (at: string) => Math.floor(elapsedMilliseconds(at, now.getTime()) / 1_000);
  const download = progress?.download ? downloadView(progress.download) : null;
  const startup = updater.progress?.startup;

  return (
    <div className="min-w-0 space-y-3">
      <div className="space-y-2" role="status" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="soft" color={stale ? "warning" : STATE_COLORS[updater.state]}>
            {t("state", { state: updater.state })}
          </Chip>
          {progress?.service ? <span className="min-w-0 break-words text-sm font-medium">{t("service", { service: progress.service })}</span> : null}
        </div>
        <p className="text-sm text-muted">{t("phaseHint", { state: updater.state })}</p>
        {updater.pending ? <p className="text-sm text-muted">{t("queued", { action: updater.pending })}</p> : null}
        {progress && progress.total > 0 ? (
          <p className="text-sm tabular-nums">{t("serviceProgress", { completed: progress.completed, total: progress.total })}</p>
        ) : null}
      </div>
      {download ? (
        <div className="space-y-1 text-sm tabular-nums">
          <p>{t("downloadBytes", {
            known: String(download.totalBytes !== null),
            downloaded: formatBytes(format, download.downloadedBytes),
            total: download.totalBytes === null ? "" : formatBytes(format, download.totalBytes),
          })}</p>
          <p>{t("downloadLayers", { completed: download.layersCompleted, total: download.layersTotal })}</p>
          <p className="text-xs text-muted">{t("cachedLayers")}</p>
        </div>
      ) : null}
      {startup ? (
        <Alert status={startup === "manual_recovery" || startup === "migration_failed" ? "danger" : "accent"}>
          <Alert.Indicator />
          <Alert.Content><Alert.Description>{t("startup", { startup })}</Alert.Description></Alert.Content>
        </Alert>
      ) : null}
      {progress ? (
        <p className="text-xs tabular-nums text-muted">
          {t("elapsed", { total: seconds(progress.startedAt), phase: seconds(progress.phaseStartedAt) })}
        </p>
      ) : null}
      {stale ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content><Alert.Description>{t("staleProgress")}</Alert.Description></Alert.Content>
        </Alert>
      ) : null}
      {!active && updater.lastResult ? (
        <div className="space-y-1 text-sm">
          <p>{t("outcome", { outcome: updater.lastResult.outcome, when: format.relativeTime(new Date(updater.lastResult.at), now) })}</p>
          {updater.lastResult.detail ? <p className="break-words text-muted">{updater.lastResult.detail}</p> : null}
        </div>
      ) : null}
      <UpdaterHistory updater={updater} />
    </div>
  );
}
