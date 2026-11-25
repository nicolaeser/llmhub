"use client";

import { Card, Chip, Label, Meter, Skeleton } from "@heroui/react";
import { useTranslations } from "next-intl";
import { LoadError } from "@/components/console/page-status";
import { usageRatio } from "@/lib/gateway/request-logs/log-live";
import { useActionData } from "@/lib/hooks/use-action-data";
import { newestOf } from "@/lib/updates/live-events";
import { meterColor } from "@/lib/utils/budget";
import { loadLogKeyUsageAction } from "../_action";
import type { LogStream } from "./use-log-stream";
import { useLiveReload } from "./use-live-reload";

const USED_TEXT = { accent: "text-muted", warning: "text-warning", danger: "text-danger" } as const;
const NO_EVENTS = 0;

export default function KeyUsageCard({
  keyId,
  stream,
  className,
}: {
  keyId: string;
  stream: LogStream;
  className?: string;
}) {
  const t = useTranslations("Logs.live");
  const state = useActionData(() => loadLogKeyUsageAction({ keyId }));
  useLiveReload(true, { connected: stream.connected, version: NO_EVENTS }, state.reload);
  const current = newestOf(state.data, stream.key);
  const usage = current?.usage ?? null;

  const header = (
    <Card.Header>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Card.Title>{t("keyTitle", { key: usage?.label || "none" })}</Card.Title>
        {current ? (
          <Chip size="sm" variant="soft" color={stream.connected ? "success" : undefined}>
            {t("status", { connected: String(stream.connected) })}
          </Chip>
        ) : null}
      </div>
      <Card.Description>{t("keyHint")}</Card.Description>
    </Card.Header>
  );

  if (!current) {
    return (
      <Card className={className}>
        {header}
        <Card.Content>
          <LoadError state={state} />
          {state.error === null ? (
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-3.5 w-1/2 rounded-lg" />
              <Skeleton className="h-2 w-full rounded-lg" />
            </div>
          ) : null}
        </Card.Content>
      </Card>
    );
  }

  if (!usage) {
    return (
      <Card className={className}>
        {header}
        <Card.Content>
          <p className="text-sm text-muted">{t("keyHidden")}</p>
        </Card.Content>
      </Card>
    );
  }

  const ratio = usageRatio(usage);
  const cap = usage.maxBudget + usage.boost;
  const tone = ratio === null ? "accent" : meterColor(ratio);
  const resetsAt = usage.resetsAt ? new Date(usage.resetsAt) : null;

  return (
    <Card className={className}>
      {header}
      <Card.Content className="space-y-2">
        {ratio === null ? (
          <p className="text-sm text-foreground tabular-nums">{t("keyNoCap", { spend: usage.spend })}</p>
        ) : (
          <>
            <Meter
              value={Math.min(1, ratio) * 100}
              color={tone}
              aria-label={t("keyMeter")}
              aria-valuetext={t("keyUsed", { used: ratio })}
            >
              <div className="flex w-full flex-wrap items-baseline justify-between gap-x-3">
                <Label className="tabular-nums">{t("keySpent", { spend: usage.spend, cap })}</Label>
                <span className={`text-sm font-medium tabular-nums ${USED_TEXT[tone]}`}>
                  {t("keyUsed", { used: ratio })}
                </span>
              </div>
              <Meter.Track>
                <Meter.Fill />
              </Meter.Track>
            </Meter>
            <p className="text-xs text-muted tabular-nums">
              {t("keyLeft", {
                left: Math.max(0, cap - usage.spend),
                resets: resetsAt ? "yes" : "no",
                at: resetsAt ?? new Date(0),
              })}
            </p>
          </>
        )}
      </Card.Content>
    </Card>
  );
}
