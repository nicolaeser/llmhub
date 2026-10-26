"use client";

import type { ReactNode } from "react";
import { Alert, Chip } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { useClock } from "@/lib/hooks/use-clock";
import { shortDigest } from "@/lib/updates/updater-view";
import type { UpdaterState, UpdaterView } from "@/types/updates";
import { AutoUpdateSwitch, UpdaterButtons } from "./updater-controls";

const STATE_COLORS: Record<UpdaterState, "default" | "accent" | "warning" | "danger"> = {
  idle: "default",
  checking: "accent",
  pulling: "accent",
  recreating: "accent",
  verifying: "accent",
  rolling_back: "warning",
  failed: "danger",
};

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </li>
  );
}

export default function UpdaterPanel({
  updater,
  canManage,
  detailed,
  onView,
}: {
  updater: UpdaterView | null;
  canManage: boolean;
  detailed: boolean;
  onView: (view: UpdaterView | null) => void;
}) {
  const t = useTranslations("Common");
  const format = useFormatter();
  const now = useClock(10_000);

  if (!updater) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">{t("updater.missing")}</p>
        {detailed ? (
          <code className="block font-mono text-xs break-all text-foreground">{t("updater.command")}</code>
        ) : null}
      </div>
    );
  }

  const when = (iso: string) => format.relativeTime(new Date(iso), now);
  const unknown = t("updater.unknown");

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border">
        <Fact label={t("updater.connection")}>
          <Chip size="sm" variant="soft" color={updater.connected ? "success" : "default"}>
            {t("updater.connected", { connected: updater.connected ? "true" : "false" })}
          </Chip>
        </Fact>
        {updater.seenAt ? <Fact label={t("updater.lastSeen")}>{when(updater.seenAt)}</Fact> : null}
        <Fact label={t("updater.stateLabel")}>
          <Chip size="sm" variant="soft" color={STATE_COLORS[updater.state]}>
            {t("updater.state", { state: updater.state })}
          </Chip>
        </Fact>
        {detailed ? (
          <>
            <Fact label={t("updater.image")}>
              <code className="font-mono text-xs break-all">
                {updater.image ? `${updater.image}:${updater.tag ?? ""}` : unknown}
              </code>
            </Fact>
            <Fact label={t("updater.running")}>
              <code className="font-mono text-xs">{shortDigest(updater.currentDigest) || unknown}</code>
            </Fact>
            <Fact label={t("updater.latest")}>
              <code className="font-mono text-xs">{shortDigest(updater.latestDigest) || unknown}</code>
            </Fact>
          </>
        ) : null}
        <Fact label={t("updater.checked")}>{updater.checkedAt ? when(updater.checkedAt) : t("updater.never")}</Fact>
        <Fact label={t("updater.availability")}>
          {t("updater.available", { available: updater.available ? "true" : "false" })}
        </Fact>
        {updater.lastResult ? (
          <Fact label={t("updater.result")}>
            {t("updater.outcome", { outcome: updater.lastResult.outcome, when: when(updater.lastResult.at) })}
          </Fact>
        ) : null}
      </ul>
      {detailed && updater.lastResult?.detail ? (
        <p className="text-xs break-words text-muted">{updater.lastResult.detail}</p>
      ) : null}
      {updater.pinned ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("updater.pinned", { tag: updater.tag ?? "" })}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {updater.issue ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("updater.issue", { issue: updater.issue })}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {canManage ? (
        <div className="space-y-4">
          <AutoUpdateSwitch updater={updater} onView={onView} />
          <UpdaterButtons updater={updater} onView={onView} size={detailed ? "md" : "sm"} />
        </div>
      ) : null}
    </div>
  );
}
