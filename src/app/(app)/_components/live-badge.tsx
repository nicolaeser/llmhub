"use client";

import { Button, Popover, Separator } from "@heroui/react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import type { ServerHealth } from "@/types/updates";
import { useBuildStatus } from "./build-status";
import UpdaterPanel, { Fact } from "./updater-panel";

const DOT_COLORS: Record<ServerHealth, string> = {
  live: "bg-success",
  updating: "bg-warning",
  reconnecting: "bg-warning",
  down: "bg-danger",
  connecting: "bg-accent",
};

export default function LiveBadge() {
  const t = useTranslations("Common");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const build = useBuildStatus();
  const health = build?.health ?? "connecting";
  const label = t("health.status", { status: health });
  const live = build?.live ?? null;
  const served = build?.served ?? null;
  const pulsing = health === "live" || health === "updating";

  return (
    <>
      <span className="sr-only" role="status">
        {label}
      </span>
      <Popover>
        <Button size="sm" variant="ghost" aria-label={t("live.open", { status: label })} className="min-w-0">
          <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
            {pulsing ? (
              <span
                className={`absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping ${DOT_COLORS[health]}`}
              />
            ) : null}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${DOT_COLORS[health]}`} />
          </span>
          <span className={health === "down" ? "truncate text-danger" : "hidden truncate sm:inline"}>{label}</span>
        </Button>
        <Popover.Content placement="bottom start" className="w-80 max-w-[calc(100vw-2rem)]">
          <Popover.Dialog className="space-y-3">
            <Popover.Heading className="text-sm font-semibold text-foreground">{t("live.title")}</Popover.Heading>
            <ul className="divide-y divide-border">
              <Fact label={t("live.connection")}>{label}</Fact>
              <Fact label={t("live.version")}>
                <code className="font-mono text-xs break-all">{served?.version ?? build?.loaded ?? ""}</code>
              </Fact>
              {served ? <Fact label={t("live.started")}>{format.relativeTime(new Date(served.startedAt), now)}</Fact> : null}
            </ul>
            {live?.canRead && build ? (
              <>
                <Separator />
                <p className="text-sm font-semibold text-foreground">{t("updater.title")}</p>
                <UpdaterPanel
                  updater={live.updater}
                  canManage={live.canManage}
                  detailed={false}
                  onView={build.setUpdater}
                />
              </>
            ) : null}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </>
  );
}
