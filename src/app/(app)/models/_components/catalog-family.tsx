"use client";

import { Button, Card, Chip, Disclosure, Label, Switch, Table } from "@heroui/react";
import { ArrowRight, ArrowRightLeft } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import SearchSelect from "@/components/console/search-select";
import SubscriptionBadge from "@/components/console/subscription-badge";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import { catalogEntryKey } from "@/lib/gateway/catalog/model-catalog";
import { setSearchParams } from "@/lib/hooks/use-search-param";
import type { CatalogEntryView, CatalogFamilyView, CatalogGroupView } from "@/types/model-catalog";

type Handlers = {
  canManage: boolean;
  busy: string | null;
  autoRoutesDefault: boolean;
  onGroupActive: (alias: string, active: boolean) => void;
  onAutoRoutes: (alias: string, autoRoutes: boolean | null) => void;
  onEntryActive: (entry: CatalogEntryView, active: boolean) => void;
  onAssign: (entry: CatalogEntryView, alias: string) => void;
};

const AUTO_MODES = ["inherit", "on", "off"] as const;

function autoMode(value: boolean | null): (typeof AUTO_MODES)[number] {
  if (value === null) return "inherit";
  return value ? "on" : "off";
}

function GroupSwitch({ group, handlers }: { group: CatalogGroupView; handlers: Handlers }) {
  const t = useTranslations("ModelCatalog");
  return (
    <Switch
      size="sm"
      isSelected={group.state === "active"}
      isDisabled={!handlers.canManage || handlers.busy === `group:${group.alias}`}
      onChange={(next) => handlers.onGroupActive(group.alias, next)}
      aria-label={t("groupToggle", { alias: group.alias })}
    >
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Label>{t("groupState", { state: group.state })}</Label>
      </Switch.Content>
    </Switch>
  );
}

function VariantBody({
  group,
  handlers,
  inset = false,
}: {
  group: CatalogGroupView;
  handlers: Handlers;
  inset?: boolean;
}) {
  const t = useTranslations("ModelCatalog");
  const tProviders = useTranslations("Providers");
  const format = useFormatter();
  const { canManage, busy } = handlers;

  function kindLabel(entry: CatalogEntryView) {
    return isSignInKind(entry.kind)
      ? tProviders("channel", { kind: entry.kind })
      : tProviders("kindName", { kind: entry.kind });
  }

  function modelCell(entry: CatalogEntryView) {
    return (
      <>
        <div className="break-all font-mono text-xs">{entry.upstreamId}</div>
        {entry.name ? <div className="text-xs text-muted">{entry.name}</div> : null}
      </>
    );
  }

  function matchCell(entry: CatalogEntryView) {
    return (
      <>
        <div className="text-sm">
          {entry.source === "jev"
            ? t("jevConfidence", { confidence: format.number(entry.confidence, "percent") })
            : t("source", { source: entry.source || "own" })}
        </div>
        {!entry.trusted && entry.status === "new" ? <div className="text-xs text-warning">{t("untrusted")}</div> : null}
      </>
    );
  }

  function entrySwitch(entry: CatalogEntryView) {
    return (
      <Switch
        size="sm"
        isSelected={entry.status === "active"}
        isDisabled={!canManage || busy === `entry:${catalogEntryKey(entry)}`}
        onChange={(next) => handlers.onEntryActive(entry, next)}
        aria-label={t("entryToggle", { model: entry.upstreamId, provider: entry.providerName })}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("entryState", { status: entry.status })}</Label>
        </Switch.Content>
      </Switch>
    );
  }

  return (
    <div className="space-y-4">
      {group.state === "missing" ? null : (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <SearchSelect
            label={t("autoRoutes")}
            description={t("autoRoutesHint")}
            items={AUTO_MODES.map((mode) => ({
              id: mode,
              label: t("autoRoutesMode", { mode, value: String(handlers.autoRoutesDefault) }),
            }))}
            value={autoMode(group.autoRoutes)}
            onChange={(mode) => handlers.onAutoRoutes(group.alias, mode === "inherit" ? null : mode === "on")}
            isDisabled={!canManage || busy === `auto:${group.alias}`}
            className="max-w-sm"
          />
          <Button
            size="sm"
            variant="secondary"
            onPress={() => setSearchParams({ tab: "groups", group: group.alias })}
          >
            {t("openModels")}
            <ArrowRight size={14} aria-hidden />
          </Button>
        </div>
      )}
      {group.entries.length ? (
        <>
          <RowCards label={group.alias}>
            {group.entries.map((entry) => {
              const key = catalogEntryKey(entry);
              return (
                <RowCard
                  key={key}
                  variant={inset ? "tertiary" : "secondary"}
                  title={entry.providerName}
                  description={kindLabel(entry)}
                  aside={entrySwitch(entry)}
                  chips={isSignInKind(entry.kind) ? <SubscriptionBadge /> : null}
                  details={[
                    { label: t("columns.model"), value: modelCell(entry), wide: true },
                    { label: t("columns.match"), value: matchCell(entry), wide: true },
                  ]}
                  actions={
                    canManage ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={busy === `entry:${key}`}
                        onPress={() => handlers.onAssign(entry, group.alias)}
                      >
                        <ArrowRightLeft size={14} aria-hidden />
                        {t("assign")}
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </RowCards>
          <Table aria-label={group.alias} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content aria-label={group.alias} className="min-w-[44rem]">
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.provider")}</Table.Column>
                  <Table.Column>{t("columns.model")}</Table.Column>
                  <Table.Column>{t("columns.match")}</Table.Column>
                  <Table.Column>{t("columns.active")}</Table.Column>
                  <Table.Column>{t("columns.actions")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {group.entries.map((entry) => {
                    const key = catalogEntryKey(entry);
                    return (
                      <Table.Row key={key} id={key}>
                        <Table.Cell>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{entry.providerName}</span>
                            {isSignInKind(entry.kind) ? <SubscriptionBadge /> : null}
                          </div>
                          <div className="text-xs text-muted">{kindLabel(entry)}</div>
                        </Table.Cell>
                        <Table.Cell>{modelCell(entry)}</Table.Cell>
                        <Table.Cell>{matchCell(entry)}</Table.Cell>
                        <Table.Cell>{entrySwitch(entry)}</Table.Cell>
                        <Table.Cell>
                          {canManage ? (
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={t("assign")}
                              isDisabled={busy === `entry:${key}`}
                              onPress={() => handlers.onAssign(entry, group.alias)}
                            >
                              <ArrowRightLeft size={14} aria-hidden />
                            </Button>
                          ) : null}
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </>
      ) : null}
    </div>
  );
}

export default function CatalogFamily({ family, handlers }: { family: CatalogFamilyView; handlers: Handlers }) {
  const t = useTranslations("ModelCatalog");
  const format = useFormatter();
  const standard = family.variants.find((variant) => !variant.tag);
  const tagged = family.variants.filter((variant) => variant.tag);
  const entries = family.variants.flatMap((variant) => variant.entries);
  const active = entries.filter((entry) => entry.status === "active").length;
  const fresh = family.variants
    .filter((variant) => variant.state !== "missing")
    .flatMap((variant) => variant.entries)
    .filter((entry) => entry.status === "new").length;
  const summary = [family.displayName, t("providers", { active, total: entries.length })].filter(Boolean);

  return (
    <Disclosure id={family.family}>
      <div className="flex flex-wrap items-center gap-3 py-2">
        <Disclosure.Heading className="min-w-0 flex-1">
          <Disclosure.Trigger className="flex w-full min-w-0 items-center gap-3 text-left">
            <Disclosure.Indicator />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate font-mono text-sm font-medium text-foreground">{family.family}</span>
                {family.vendor ? (
                  <Chip size="sm" variant="soft">
                    {family.vendor}
                  </Chip>
                ) : null}
                {tagged.map((variant) => (
                  <Chip key={variant.alias} size="sm" variant="soft" color="warning">
                    {t("tag", { tag: variant.tag })}
                  </Chip>
                ))}
                {fresh ? (
                  <Chip size="sm" variant="soft" color="accent">
                    {t("newProviders", { count: fresh })}
                  </Chip>
                ) : null}
              </span>
              <span className="block truncate text-xs text-muted">{format.list(summary, { type: "unit" })}</span>
            </span>
          </Disclosure.Trigger>
        </Disclosure.Heading>
        {standard ? <GroupSwitch group={standard} handlers={handlers} /> : null}
      </div>
      <Disclosure.Content>
        <Disclosure.Body className="space-y-4 pb-4">
          {standard ? <VariantBody group={standard} handlers={handlers} /> : null}
          {tagged.map((variant) => (
            <Card key={variant.alias} variant="secondary">
              <Card.Content className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Chip size="sm" variant="soft" color="warning">
                      {t("tag", { tag: variant.tag })}
                    </Chip>
                    <span className="truncate font-mono text-sm font-medium text-foreground">{variant.alias}</span>
                  </div>
                  <GroupSwitch group={variant} handlers={handlers} />
                </div>
                <VariantBody group={variant} handlers={handlers} inset />
              </Card.Content>
            </Card>
          ))}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
