"use client";

import { Card, Chip, Table } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { PlanBadge } from "@/components/console/subscription-badge";
import { kindIcon } from "@/components/providers/kind-icons";
import type { ProviderView, UsageKeyLabel } from "@/types/providers";
import type { AccountRow } from "./account-rows";
import { ACCOUNT_STATE_COLOR } from "./account-status";
import KeyUsageBar, { SegmentDot } from "./key-usage-bar";
import { barSegments, keyShade, type AccountUsage, type BarSegment, type KeyRow, type WindowView } from "./key-usage-view";
import { ResetLine, useLimitLabel } from "./limit-meter";
import { useResetTime } from "./use-reset-time";

const FULL_PERCENT = 100;
const WARN_PERCENT = 80;

type KeyName = { label: string; detail: string };

export function useKeyName(): (keyId: string, keys: Record<string, UsageKeyLabel>) => KeyName {
  const t = useTranslations("Subscriptions.keyUsage");
  return (keyId, keys) => {
    if (!keyId) return { label: t("noKey"), detail: t("noKeyHint") };
    const key = keys[keyId];
    if (!key) return { label: t("deletedKey"), detail: "" };
    return { label: key.label, detail: [key.company, key.owner].filter(Boolean).join(" · ") };
  };
}

function usedTone(used: number): string {
  if (used >= FULL_PERCENT) return "text-sm font-medium tabular-nums text-danger";
  if (used >= WARN_PERCENT) return "text-sm font-medium tabular-nums text-warning";
  return "text-sm font-medium tabular-nums text-foreground";
}

export default function KeyUsageAccount({
  row,
  account,
  usage,
  keys,
  timeZone,
}: {
  row: ProviderView;
  account: AccountRow;
  usage: AccountUsage;
  keys: Record<string, UsageKeyLabel>;
  timeZone: string;
}) {
  const t = useTranslations("Subscriptions.keyUsage");
  const tSubscriptions = useTranslations("Subscriptions");
  const tLimits = useTranslations("Subscriptions.limits");
  const tProviders = useTranslations("Providers");
  const format = useFormatter();
  const { now } = useResetTime(timeZone);
  const limitLabel = useLimitLabel();
  const keyName = useKeyName();
  const ranks = new Map(usage.keys.map((key) => [key.keyId, key.rank]));
  const Icon = kindIcon(row.kind);
  const percent = (value: number) =>
    format.number(value / FULL_PERCENT, { style: "percent", maximumFractionDigits: value > 0 && value < 10 ? 1 : 0 });

  const segmentName = (segment: BarSegment) => {
    if (segment.kind === "other") return t("otherKeys", { count: segment.keyIds.length });
    if (segment.kind === "outside") return t("outside");
    return keyName(segment.id, keys).label;
  };

  const keyTitle = (key: KeyRow) => {
    const shade = keyShade(key.rank);
    return (
      <span className="flex min-w-0 items-center gap-2">
        <SegmentDot kind={shade === null ? "other" : "key"} shade={shade ?? 0.5} />
        <span className="min-w-0 font-medium break-words">{keyName(key.keyId, keys).label}</span>
      </span>
    );
  };

  const windowCell = (key: KeyRow, window: WindowView) => {
    const slice = key.byWindow[window.group.id];
    return (
      <span className="flex flex-col">
        <span className="text-sm font-medium tabular-nums text-foreground">{percent(slice?.percent ?? 0)}</span>
        {slice ? (
          <span className="text-xs break-words text-muted">
            {t("share", { share: slice.share, requests: slice.requests })}
          </span>
        ) : null}
      </span>
    );
  };

  const windowBlock = (window: WindowView) => {
    const { group } = window;
    const label = limitLabel(group);
    const reset = group.resetsAt ? Date.parse(group.resetsAt) : NaN;
    return (
      <div key={group.id} className="min-w-0 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 text-sm break-words text-foreground">{label}</span>
          <span className={usedTone(group.usedPercent)}>
            {tLimits("used", { used: group.usedPercent / FULL_PERCENT, uniform: String(group.uniform) })}
          </span>
        </div>
        <KeyUsageBar
          label={label}
          segments={barSegments(window, ranks)}
          used={group.usedPercent}
          nameOf={segmentName}
          freeLabel={t("free")}
        />
        {Number.isFinite(reset) && reset > now.getTime() ? (
          <ResetLine at={reset} reached={group.limitReached} timeZone={timeZone} />
        ) : null}
        <p className="text-xs text-muted">
          {window.usage
            ? t("windowRequests", { count: window.usage.requests, basis: window.usage.basis })
            : t("windowPending")}
        </p>
      </div>
    );
  };

  const tableLabel = t("keysOn", { account: account.title });

  return (
    <Card>
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <IconTile icon={Icon} tone="accent" />
          <div className="min-w-0">
            <Card.Title className="break-words">{account.title}</Card.Title>
            <Card.Description className="break-words">
              {account.subtitle
                ? t("accountKind", { kind: tProviders("kindName", { kind: row.kind }), name: account.subtitle })
                : tProviders("kindName", { kind: row.kind })}
            </Card.Description>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <PlanBadge plan={account.plan} />
          <Chip size="sm" variant="soft" color={ACCOUNT_STATE_COLOR[account.state]} className="whitespace-nowrap">
            {tSubscriptions("status", { status: account.state })}
          </Chip>
        </div>
      </Card.Header>
      <Card.Content className="space-y-5">
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">{usage.windows.map(windowBlock)}</div>

        {usage.keys.length === 0 ? (
          <p className="text-sm text-muted">{t("noRequests")}</p>
        ) : (
          <>
            <RowCards label={tableLabel}>
              {usage.keys.map((key) => (
                <RowCard
                  key={key.keyId || "none"}
                  variant="secondary"
                  title={keyTitle(key)}
                  description={keyName(key.keyId, keys).detail || undefined}
                  details={usage.windows.map((window) => ({
                    label: limitLabel(window.group),
                    value: windowCell(key, window),
                  }))}
                />
              ))}
            </RowCards>
            <Table aria-label={tableLabel} className={TABLE_FROM_LG}>
              <Table.ScrollContainer>
                <Table.Content aria-label={tableLabel} className="min-w-[40rem]">
                  <Table.Header>
                    <Table.Column id="key" isRowHeader>
                      {t("columns.key")}
                    </Table.Column>
                    {usage.windows.map((window) => (
                      <Table.Column key={window.group.id} id={window.group.id}>
                        {limitLabel(window.group)}
                      </Table.Column>
                    ))}
                  </Table.Header>
                  <Table.Body>
                    {usage.keys.map((key) => (
                      <Table.Row key={key.keyId || "none"} id={key.keyId || "none"}>
                        <Table.Cell>
                          {keyTitle(key)}
                          {keyName(key.keyId, keys).detail ? (
                            <div className="pl-4.5 text-xs break-words text-muted">{keyName(key.keyId, keys).detail}</div>
                          ) : null}
                        </Table.Cell>
                        {usage.windows.map((window) => (
                          <Table.Cell key={window.group.id}>{windowCell(key, window)}</Table.Cell>
                        ))}
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          </>
        )}
      </Card.Content>
    </Card>
  );
}
