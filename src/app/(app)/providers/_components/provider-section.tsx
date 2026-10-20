"use client";

import { Button, Card, Chip, Skeleton } from "@heroui/react";
import { Plus, SlidersHorizontal, TimerReset } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import SubscriptionBadge from "@/components/console/subscription-badge";
import { kindIcon } from "@/components/providers/kind-icons";
import { reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import type { AccountStrategy, LimitSnapshot, ProviderView, SignInKind } from "@/types/providers";
import type { AutoResetPolicy } from "@/types/resets";
import AccountCard from "./account-card";
import { STRATEGY_ICONS } from "./account-routing-picker";
import { ACCOUNT_STATE_COLOR, type CountedState } from "./account-status";

export default function ProviderSection({
  kind,
  rows,
  counts,
  limits,
  settingsLoaded,
  strategy,
  autoReset,
  canManage,
  canAdd,
  timeZone,
  refreshing,
  onAdd,
  onSettings,
  onRefresh,
  onItem,
  onEdit,
  onImport,
  onAccess,
  onToggled,
  onDeleted,
}: {
  kind: SignInKind;
  rows: ProviderView[];
  counts: { state: CountedState; count: number }[];
  limits: Record<string, LimitSnapshot>;
  settingsLoaded: boolean;
  strategy: AccountStrategy;
  autoReset: AutoResetPolicy | null;
  canManage: boolean;
  canAdd: boolean;
  timeZone: string;
  refreshing: string[];
  onAdd: () => void;
  onSettings: () => void;
  onRefresh: (id: string) => void;
  onItem: (item: LimitSnapshot | null) => void;
  onEdit: (row: ProviderView) => void;
  onImport: (row: ProviderView) => void;
  onAccess: (row: ProviderView) => void;
  onToggled: (provider: ProviderView) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("Subscriptions");
  const tRouting = useTranslations("Subscriptions.routing");
  const tProviders = useTranslations("Providers");
  const format = useFormatter();
  const name = tProviders("kindShort", { kind });
  const StrategyIcon = STRATEGY_ICONS[strategy];
  const titleId = `subscriptions-${kind}`;

  return (
    <Card aria-labelledby={titleId} className="gap-5">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
          <IconTile icon={kindIcon(kind)} size="lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Card.Title id={titleId}>{name}</Card.Title>
                <SubscriptionBadge />
              </div>
              <Card.Description>
                {t("section.description", { channel: tProviders("channel", { kind }), count: rows.length })}
              </Card.Description>
            </div>
            <div className="flex flex-wrap gap-1">
              {counts.map(({ state, count }) => (
                <Chip key={state} size="sm" variant="soft" color={ACCOUNT_STATE_COLOR[state]} className="whitespace-nowrap">
                  {t("stateCount", { state, count })}
                </Chip>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="tertiary" aria-label={t("settings.openFor", { provider: name })} onPress={onSettings}>
            <SlidersHorizontal size={14} aria-hidden />
            {t("settings.open")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!canAdd}
            aria-label={tProviders("formTitle", { mode: "connect", name: tProviders("kindName", { kind }) })}
            onPress={onAdd}
          >
            <Plus size={14} aria-hidden />
            {t("addAccount")}
          </Button>
        </div>
      </Card.Header>

      <Card.Content className="gap-4">
        {settingsLoaded ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
            <span className="flex min-w-0 items-center gap-2">
              <StrategyIcon size={14} aria-hidden className="shrink-0 text-accent" />
              <span className="min-w-0">
                {t("settings.routingSummary", { method: tRouting("method", { strategy }) })}
              </span>
            </span>
            {autoReset ? (
              <span className="flex min-w-0 items-center gap-2">
                <TimerReset size={14} aria-hidden className={autoReset.enabled ? "shrink-0 text-success" : "shrink-0"} />
                <span className="min-w-0">
                  {t("settings.autoResetSummary", {
                    enabled: String(autoReset.enabled),
                    percent: format.number(autoReset.percent / 100, { style: "percent" }),
                  })}
                </span>
              </span>
            ) : null}
          </div>
        ) : (
          <Skeleton className="h-4 w-72 max-w-full rounded-lg" />
        )}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {rows.map((row) => (
            <AccountCard
              key={row.id}
              row={row}
              reports={reportsLimits(row.kind)}
              entry={limits[row.id]}
              timeZone={timeZone}
              refreshing={refreshing.includes(row.id)}
              canManage={canManage}
              onRefresh={onRefresh}
              onItem={onItem}
              onEdit={onEdit}
              onImport={onImport}
              onAccess={onAccess}
              onToggled={onToggled}
              onDeleted={onDeleted}
            />
          ))}
        </div>
      </Card.Content>
    </Card>
  );
}
