"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  DisclosureGroup,
  Label,
  ListBox,
  SearchField,
  Select,
  Separator,
  Spinner,
  toast,
  useOverlayState,
} from "@heroui/react";
import { BookOpen, RefreshCw } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import {
  loadCatalogAction,
  refreshCatalogAction,
  setCatalogEntryActiveAction,
  setCatalogGroupActiveAction,
  setCatalogGroupAutoRoutesAction,
} from "@/app/(app)/model-catalog/_action";
import { isActionFail } from "@/lib/http/action-result";
import { catalogEntryKey } from "@/lib/gateway/model-catalog";
import type { ActionFail } from "@/types/actions";
import type { CatalogEntryView, CatalogGroupView, CatalogView } from "@/types/model-catalog";
import AssignDialog from "./_components/assign-dialog";
import CatalogGroup from "./_components/catalog-group";

const FILTERS = ["all", "active", "fresh", "missing", "disabled"] as const;
const PAGE_SIZE = 40;
const HOUR_MS = 3_600_000;

type Filter = (typeof FILTERS)[number];

function matchesFilter(group: CatalogGroupView, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "fresh") return group.state !== "missing" && group.entries.some((entry) => entry.status === "new");
  return group.state === filter;
}

function matchesQuery(group: CatalogGroupView, query: string): boolean {
  if (!query) return true;
  return [group.alias, group.vendor, group.displayName]
    .concat(group.entries.flatMap((entry) => [entry.upstreamId, entry.providerName]))
    .some((value) => value.toLowerCase().includes(query));
}

export default function ModelCatalogPage() {
  const t = useTranslations("ModelCatalog");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const [view, setView] = useState<CatalogView | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<{ entry: CatalogEntryView; alias: string } | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [refreshing, startRefresh] = useTransition();
  const [, startChange] = useTransition();
  const assignState = useOverlayState();

  useEffect(() => {
    loadCatalogAction().then((res) => {
      if (isActionFail(res)) {
        toast.danger(tError("code", { code: res.error }));
        return;
      }
      setView(res);
    });
  }, [tError]);

  function apply(result: CatalogView | ActionFail, success?: string) {
    if (isActionFail(result)) {
      toast.danger(tError("code", { code: result.error }));
      return;
    }
    setView(result);
    if (success) toast(success, { variant: "success" });
  }

  function change(key: string, run: () => Promise<CatalogView | ActionFail>) {
    setBusy(key);
    startChange(async () => {
      apply(await run(), t("saved"));
      setBusy(null);
    });
  }

  function refresh() {
    startRefresh(async () => {
      apply(await refreshCatalogAction(), t("refreshed"));
    });
  }

  function openAssign(entry: CatalogEntryView, alias: string) {
    setAssigning({ entry, alias });
    setDialogKey((n) => n + 1);
    assignState.open();
  }

  if (!view) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  const state = view.state;
  const hours = view.refreshMs / HOUR_MS;
  const needle = query.trim().toLowerCase();
  const visible = view.groups.filter((group) => matchesFilter(group, filter) && matchesQuery(group, needle));
  const shown = visible.slice(0, limit);
  const refreshButton = view.canManage ? (
    <Button isPending={refreshing} onPress={refresh}>
      {({ isPending }) => (
        <>
          {isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={16} aria-hidden />}
          {t("refresh")}
        </>
      )}
    </Button>
  ) : undefined;

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={refreshButton} />

      {view.canManage ? null : (
        <Alert status="accent">
          <Alert.Content>
            <Alert.Description>{t("readOnly")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <Card>
        <Card.Content className="space-y-2 text-sm">
          <p className="text-foreground">
            {state
              ? t("lastRefresh", { when: format.relativeTime(new Date(state.refreshedAt), now), hours })
              : t("neverRefreshed", { hours })}
          </p>
          {view.jevReady && state?.jev.configured ? (
            <p className="text-muted">
              {t("jev.summary", {
                asked: state.jev.asked,
                matched: state.jev.matched,
                cost: format.number(state.jev.cost, "money"),
              })}
            </p>
          ) : null}
          {view.jevReady && state && state.jev.pending > 0 ? (
            <p className="text-muted">{t("jev.pending", { count: state.jev.pending })}</p>
          ) : null}
        </Card.Content>
      </Card>

      {view.jevReady ? null : (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("jev.missingTitle")}</Alert.Title>
            <Alert.Description>
              {t.rich("jev.missing", {
                link: (chunks) => (
                  <Link href="/admin-settings" className="text-accent">
                    {chunks}
                  </Link>
                ),
              })}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {state?.jev.error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("jev.errorTitle")}</Alert.Title>
            <Alert.Description>{t("jev.error", { code: state.jev.error })}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {state?.failed.length ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("failedTitle")}</Alert.Title>
            <Alert.Description>
              <ul className="space-y-1">
                {state.failed.map((failure) => (
                  <li key={failure.providerId}>{t("failed", { name: failure.name, code: failure.code })}</li>
                ))}
              </ul>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {view.groups.length === 0 ? (
        <EmptyState icon={BookOpen} title={t("emptyTitle")} description={t("empty")} action={refreshButton} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <SearchField
              value={query}
              onChange={(value) => {
                setQuery(value);
                setLimit(PAGE_SIZE);
              }}
              aria-label={t("search")}
              className="w-full max-w-sm"
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={t("search")} />
                <SearchField.ClearButton aria-label={tCommon("close")} />
              </SearchField.Group>
            </SearchField>
            <Select
              selectedKey={filter}
              onSelectionChange={(key) => {
                setFilter(String(key) as Filter);
                setLimit(PAGE_SIZE);
              }}
              className="w-full sm:w-56"
            >
              <Label>{t("filter.label")}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox aria-label={t("filter.label")}>
                  {FILTERS.map((option) => (
                    <ListBox.Item key={option} id={option} textValue={t("filter.option", { filter: option })}>
                      {t("filter.option", { filter: option })}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <Card>
            <Card.Content>
              {shown.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted">{t("noResults")}</p>
              ) : (
                <DisclosureGroup allowsMultipleExpanded>
                  {shown.map((group, index) => (
                    <div key={group.alias}>
                      {index ? <Separator /> : null}
                      <CatalogGroup
                        group={group}
                        canManage={view.canManage}
                        busy={busy}
                        onGroupActive={(alias, active) =>
                          change(`group:${alias}`, () => setCatalogGroupActiveAction({ alias, active }))
                        }
                        onAutoRoutes={(alias, autoRoutes) =>
                          change(`auto:${alias}`, () => setCatalogGroupAutoRoutesAction({ alias, autoRoutes }))
                        }
                        onEntryActive={(entry, active) =>
                          change(`entry:${catalogEntryKey(entry)}`, () =>
                            setCatalogEntryActiveAction({
                              providerId: entry.providerId,
                              upstreamId: entry.upstreamId,
                              active,
                            }),
                          )
                        }
                        onAssign={openAssign}
                      />
                    </div>
                  ))}
                </DisclosureGroup>
              )}
            </Card.Content>
            {visible.length > shown.length ? (
              <Card.Footer>
                <Button variant="secondary" onPress={() => setLimit((n) => n + PAGE_SIZE)}>
                  {t("more", { count: Math.min(PAGE_SIZE, visible.length - shown.length) })}
                </Button>
              </Card.Footer>
            ) : null}
          </Card>
        </div>
      )}

      <AssignDialog
        key={dialogKey}
        state={assignState}
        entry={assigning?.entry ?? null}
        current={assigning?.alias ?? ""}
        aliases={view.groups.map((group) => group.alias)}
        onSaved={setView}
      />
    </div>
  );
}
