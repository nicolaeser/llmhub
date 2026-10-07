"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  DisclosureGroup,
  SearchField,
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
import SearchSelect from "@/components/console/search-select";
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
import type { CatalogEntryView, CatalogFamilyView, CatalogGroupView, CatalogView } from "@/types/model-catalog";
import AssignDialog from "./_components/assign-dialog";
import CatalogFamily from "./_components/catalog-family";

const FILTERS = ["all", "active", "fresh", "missing", "disabled"] as const;
const PAGE_SIZE = 40;
const HOUR_MS = 3_600_000;

type Filter = (typeof FILTERS)[number];

const STANDARD_TAG = "standard";
const ALL_TAGS = "all";

function matchesFilter(group: CatalogGroupView, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "fresh") return group.state !== "missing" && group.entries.some((entry) => entry.status === "new");
  return group.state === filter;
}

function matchesTag(group: CatalogGroupView, tag: string): boolean {
  if (tag === ALL_TAGS) return true;
  return tag === STANDARD_TAG ? !group.tag : group.tag === tag;
}

function matchesQuery(family: CatalogFamilyView, group: CatalogGroupView, query: string): boolean {
  if (!query) return true;
  return [family.family, group.alias, group.vendor, group.displayName]
    .concat(group.entries.flatMap((entry) => [entry.upstreamId, entry.providerName]))
    .some((value) => value.toLowerCase().includes(query));
}

function visibleFamilies(families: CatalogFamilyView[], filter: Filter, tag: string, query: string) {
  return families.flatMap((family) => {
    const variants = family.variants.filter(
      (group) => matchesFilter(group, filter) && matchesTag(group, tag) && matchesQuery(family, group, query),
    );
    return variants.length ? [{ ...family, variants }] : [];
  });
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
  const [tag, setTag] = useState(ALL_TAGS);
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
  const visible = visibleFamilies(view.families, filter, tag, needle);
  const shown = visible.slice(0, limit);
  const handlers = {
    canManage: view.canManage,
    busy,
    autoRoutesDefault: view.autoRoutesDefault,
    onGroupActive: (alias: string, active: boolean) =>
      change(`group:${alias}`, () => setCatalogGroupActiveAction({ alias, active })),
    onAutoRoutes: (alias: string, autoRoutes: boolean | null) =>
      change(`auto:${alias}`, () => setCatalogGroupAutoRoutesAction({ alias, autoRoutes })),
    onEntryActive: (entry: CatalogEntryView, active: boolean) =>
      change(`entry:${catalogEntryKey(entry)}`, () =>
        setCatalogEntryActiveAction({ providerId: entry.providerId, upstreamId: entry.upstreamId, active }),
      ),
    onAssign: openAssign,
  };
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

      {view.families.length === 0 ? (
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
            <SearchSelect
              label={t("filter.label")}
              items={FILTERS.map((option) => ({ id: option, label: t("filter.option", { filter: option }) }))}
              value={filter}
              onChange={(key) => {
                setFilter(key as Filter);
                setLimit(PAGE_SIZE);
              }}
              className="w-full sm:w-56"
            />
            {view.tags.length ? (
              <SearchSelect
                label={t("tagFilter")}
                items={[ALL_TAGS, STANDARD_TAG, ...view.tags].map((option) => ({
                  id: option,
                  label: t("tagOption", { tag: option }),
                }))}
                value={tag}
                onChange={(key) => {
                  setTag(key);
                  setLimit(PAGE_SIZE);
                }}
                className="w-full sm:w-56"
              />
            ) : null}
          </div>
          <Card>
            <Card.Content>
              {shown.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted">{t("noResults")}</p>
              ) : (
                <DisclosureGroup allowsMultipleExpanded>
                  {shown.map((family, index) => (
                    <div key={family.family}>
                      {index ? <Separator /> : null}
                      <CatalogFamily family={family} handlers={handlers} />
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
        aliases={view.families.flatMap((family) => family.variants.map((group) => group.alias))}
        onSaved={setView}
      />
    </div>
  );
}
