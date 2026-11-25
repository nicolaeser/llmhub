"use client";

import { Card, Chip, Spinner } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useClock } from "@/lib/hooks/use-clock";
import type { RunningRequest } from "@/types/logs";
import { useSessionFormat } from "./session-format";

const TICK_MS = 1_000;

export default function RunningRequests({
  items,
  keyLabel,
  className,
}: {
  items: RunningRequest[];
  keyLabel?: (keyId: string) => string;
  className?: string;
}) {
  const t = useTranslations("Logs.live");
  const session = useSessionFormat();
  const now = useClock(TICK_MS).getTime();

  if (!items.length) return null;

  return (
    <Card className={className}>
      <Card.Header>
        <Card.Title className="flex items-center gap-2">
          <Spinner size="sm" />
          <span aria-live="polite">{t("runningTitle", { count: items.length })}</span>
        </Card.Title>
        <Card.Description>{t("runningHint")}</Card.Description>
      </Card.Header>
      <Card.Content>
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium break-words text-foreground">
                  {item.model || t("unknownModel")}
                </span>
                <span className="font-mono text-xs break-all text-muted">{item.endpoint}</span>
                {item.stream ? (
                  <Chip size="sm" variant="soft">
                    {t("streaming")}
                  </Chip>
                ) : null}
                {keyLabel && item.keyId ? (
                  <span className="text-xs break-words text-muted">{keyLabel(item.keyId)}</span>
                ) : null}
              </span>
              <span className="text-sm whitespace-nowrap text-muted tabular-nums">
                {t("runningFor", { duration: session.duration(now - Date.parse(item.startedAt)) })}
              </span>
            </li>
          ))}
        </ul>
      </Card.Content>
    </Card>
  );
}
