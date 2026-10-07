"use client";

import { Button, Chip, Description, Disclosure, Label, Switch, Table } from "@heroui/react";
import { ArrowRightLeft } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { catalogEntryKey } from "@/lib/gateway/model-catalog";
import type { CatalogEntryView, CatalogGroupView } from "@/types/model-catalog";

export default function CatalogGroup({
  group,
  canManage,
  busy,
  onGroupActive,
  onAutoRoutes,
  onEntryActive,
  onAssign,
}: {
  group: CatalogGroupView;
  canManage: boolean;
  busy: string | null;
  onGroupActive: (alias: string, active: boolean) => void;
  onAutoRoutes: (alias: string, autoRoutes: boolean) => void;
  onEntryActive: (entry: CatalogEntryView, active: boolean) => void;
  onAssign: (entry: CatalogEntryView, alias: string) => void;
}) {
  const t = useTranslations("ModelCatalog");
  const tProviders = useTranslations("Providers");
  const format = useFormatter();
  const active = group.entries.filter((entry) => entry.status === "active").length;
  const fresh = group.state === "missing" ? 0 : group.entries.filter((entry) => entry.status === "new").length;
  const summary = [group.displayName, t("providers", { active, total: group.entries.length })].filter(Boolean);

  return (
    <Disclosure id={group.alias}>
      <div className="flex flex-wrap items-center gap-3 py-2">
        <Disclosure.Heading className="min-w-0 flex-1">
          <Disclosure.Trigger className="flex w-full min-w-0 items-center gap-3 text-left">
            <Disclosure.Indicator />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate font-mono text-sm font-medium text-foreground">{group.alias}</span>
                {group.vendor ? (
                  <Chip size="sm" variant="soft">
                    {group.vendor}
                  </Chip>
                ) : null}
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
        <Switch
          size="sm"
          isSelected={group.state === "active"}
          isDisabled={!canManage || busy === `group:${group.alias}`}
          onChange={(next) => onGroupActive(group.alias, next)}
          aria-label={t("groupToggle", { alias: group.alias })}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("groupState", { state: group.state })}</Label>
          </Switch.Content>
        </Switch>
      </div>
      <Disclosure.Content>
        <Disclosure.Body className="space-y-4 pb-4">
          {group.state === "missing" ? null : (
            <div className="flex flex-wrap items-start justify-between gap-4">
              <Switch
                isSelected={group.autoRoutes}
                isDisabled={!canManage || busy === `auto:${group.alias}`}
                onChange={(next) => onAutoRoutes(group.alias, next)}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>{t("autoRoutes")}</Label>
                </Switch.Content>
                <Description>{t("autoRoutesHint")}</Description>
              </Switch>
              <Link href="/models" className="text-sm font-medium text-accent">
                {t("openModels")}
              </Link>
            </div>
          )}
          {group.entries.length ? (
            <Table aria-label={group.alias}>
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
                            <div className="font-medium">{entry.providerName}</div>
                            <div className="text-xs text-muted">{tProviders("kindName", { kind: entry.kind })}</div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="break-all font-mono text-xs">{entry.upstreamId}</div>
                            {entry.name ? <div className="text-xs text-muted">{entry.name}</div> : null}
                          </Table.Cell>
                          <Table.Cell>
                            <div className="text-sm">
                              {entry.source === "jev"
                                ? t("jevConfidence", { confidence: format.number(entry.confidence, "percent") })
                                : t("source", { source: entry.source || "own" })}
                            </div>
                            {!entry.trusted && entry.status === "new" ? (
                              <div className="text-xs text-warning">{t("untrusted")}</div>
                            ) : null}
                          </Table.Cell>
                          <Table.Cell>
                            <Switch
                              size="sm"
                              isSelected={entry.status === "active"}
                              isDisabled={!canManage || busy === `entry:${key}`}
                              onChange={(next) => onEntryActive(entry, next)}
                              aria-label={t("entryToggle", { model: entry.upstreamId, provider: entry.providerName })}
                            >
                              <Switch.Content>
                                <Switch.Control>
                                  <Switch.Thumb />
                                </Switch.Control>
                                <Label>{t("entryState", { status: entry.status })}</Label>
                              </Switch.Content>
                            </Switch>
                          </Table.Cell>
                          <Table.Cell>
                            {canManage ? (
                              <Button
                                isIconOnly
                                size="sm"
                                variant="ghost"
                                aria-label={t("assign")}
                                isDisabled={busy === `entry:${key}`}
                                onPress={() => onAssign(entry, group.alias)}
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
          ) : null}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
