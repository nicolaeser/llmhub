"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { Alert, Button, SearchField, Table, toast, useOverlayState } from "@heroui/react";
import { Library, Plus, SearchX } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import SearchSelect from "@/components/console/search-select";
import { useErrorToast } from "@/components/console/use-error-toast";
import { deleteKnowledgeAction, loadKnowledgeAction } from "./_action";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import { formatBytes } from "@/lib/utils/bytes";
import type { VectorStoreView } from "@/types/rag";
import FilesDialog from "./_components/files-dialog";
import { StoreActions, StoreActivity, StoreFiles, StoreName, StoreOwner, StoreStatusChip } from "./_components/store-cells";
import StoreDialog from "./_components/store-dialog";

const ALL_COMPANIES = ":all";

const SEARCH_FROM = 6;

export default function KnowledgePage() {
  const t = useTranslations("Knowledge");
  const showError = useErrorToast();
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [query, setQuery] = useState("");
  const [company, setCompany] = useState(ALL_COMPANIES);
  const [editing, setEditing] = useState<VectorStoreView | null>(null);
  const [filesId, setFilesId] = useState<string | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [filesKey, setFilesKey] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [, startDelete] = useTransition();
  const formState = useOverlayState();
  const filesState = useOverlayState();
  const page = useActionData(loadKnowledgeAction);
  const { data: view, setData } = page;
  const stores = view?.stores;

  const setStores = useCallback(
    (update: (current: VectorStoreView[]) => VectorStoreView[]) =>
      setData((current) => ({ ...current, stores: update(current.stores) })),
    [setData],
  );

  const upsert = useCallback(
    (store: VectorStoreView) => {
      setStores((current) =>
        current.some((row) => row.id === store.id)
          ? current.map((row) => (row.id === store.id ? store : row))
          : [store, ...current],
      );
    },
    [setStores],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (stores ?? []).filter(
      (store) =>
        (company === ALL_COMPANIES || store.orgId === company) && (!q || store.name.toLowerCase().includes(q)),
    );
  }, [stores, query, company]);

  function openDialog(store: VectorStoreView | null) {
    setEditing(store);
    setDialogKey((n) => n + 1);
    formState.open();
  }

  function openFiles(store: VectorStoreView) {
    setFilesId(store.id);
    setFilesKey((n) => n + 1);
    filesState.open();
  }

  function remove(id: string) {
    setDeleting(id);
    startDelete(async () => {
      const result = await deleteKnowledgeAction(id);
      setDeleting(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setStores((current) => current.filter((row) => row.id !== result.id));
      toast(t("toasts.deleted"), { variant: "success" });
    });
  }

  if (!view || !stores) {
    return <PageStatus icon={Library} title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  const canManage = view.canManage;
  const filesStore = filesId ? (stores.find((store) => store.id === filesId) ?? null) : null;
  const createButton =
    canManage && view.companies.length ? (
      <Button onPress={() => openDialog(null)}>
        <Plus size={16} aria-hidden />
        {t("add")}
      </Button>
    ) : undefined;

  function actions(store: VectorStoreView) {
    return (
      <StoreActions
        store={store}
        canManage={canManage}
        deleting={deleting === store.id}
        onFiles={() => openFiles(store)}
        onEdit={() => openDialog(store)}
        onDelete={() => remove(store.id)}
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Library}
        title={t("title")}
        subtitle={t("subtitle")}
        actions={stores.length ? createButton : undefined}
      />

      {canManage ? null : (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("readOnly")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {stores.length === 0 ? (
        <EmptyState icon={Library} title={t("emptyTitle")} description={t("empty")} action={createButton} />
      ) : (
        <>
          {stores.length >= SEARCH_FROM || view.companies.length > 1 ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              {stores.length >= SEARCH_FROM ? (
                <SearchField value={query} onChange={setQuery} aria-label={t("search")} className="w-full sm:max-w-xs">
                  <SearchField.Group>
                    <SearchField.SearchIcon />
                    <SearchField.Input placeholder={t("search")} />
                    <SearchField.ClearButton aria-label={tCommon("close")} />
                  </SearchField.Group>
                </SearchField>
              ) : null}
              {view.companies.length > 1 ? (
                <SearchSelect
                  hideLabel
                  label={t("companyFilter")}
                  items={[
                    { id: ALL_COMPANIES, label: t("allCompanies") },
                    ...view.companies.map((item) => ({ id: item.id, label: item.alias })),
                  ]}
                  value={company}
                  onChange={setCompany}
                  className="w-full sm:max-w-xs"
                />
              ) : null}
            </div>
          ) : null}

          {filtered.length === 0 ? (
            <EmptyState icon={SearchX} title={t("noMatches")} description={t("noMatchesHint")} />
          ) : (
            <>
              <RowCards label={t("title")}>
                {filtered.map((store) => (
                  <RowCard
                    key={store.id}
                    title={store.name}
                    description={<StoreOwner store={store} />}
                    aside={<StoreStatusChip store={store} />}
                    details={[
                      ...(store.description ? [{ label: t("dialog.description"), value: store.description, wide: true }] : []),
                      { label: t("columns.files"), value: <StoreFiles store={store} /> },
                      { label: t("columns.size"), value: formatBytes(format, store.usageBytes) },
                      { label: t("columns.lastActive"), value: <StoreActivity store={store} />, wide: true },
                    ]}
                    actions={actions(store)}
                  />
                ))}
              </RowCards>
              <Table aria-label={t("title")} className={TABLE_FROM_LG}>
                <Table.ScrollContainer>
                  <Table.Content aria-label={t("title")}>
                    <Table.Header>
                      <Table.Column isRowHeader>{t("columns.name")}</Table.Column>
                      <Table.Column>{t("columns.status")}</Table.Column>
                      <Table.Column>{t("columns.files")}</Table.Column>
                      <Table.Column>{t("columns.size")}</Table.Column>
                      <Table.Column>{t("columns.lastActive")}</Table.Column>
                      <Table.Column>
                        <span className="sr-only">{tCommon("actions")}</span>
                      </Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {filtered.map((store) => (
                        <Table.Row key={store.id} id={store.id}>
                          <Table.Cell>
                            <StoreName store={store} />
                          </Table.Cell>
                          <Table.Cell>
                            <StoreStatusChip store={store} />
                          </Table.Cell>
                          <Table.Cell>
                            <StoreFiles store={store} />
                          </Table.Cell>
                          <Table.Cell>
                            <span className="text-sm tabular-nums">{formatBytes(format, store.usageBytes)}</span>
                          </Table.Cell>
                          <Table.Cell>
                            <StoreActivity store={store} />
                          </Table.Cell>
                          <Table.Cell>{actions(store)}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </>
          )}
          <p className="text-xs text-muted">{t("howItWorks")}</p>
        </>
      )}

      {canManage ? (
        <StoreDialog
          key={dialogKey}
          state={formState}
          editing={editing}
          companies={view.companies}
          projects={view.projects}
          defaults={view.defaults}
          models={view.models}
          canTestModels={view.canTestModels}
          initialCompany={company === ALL_COMPANIES ? "" : company}
          onSaved={upsert}
        />
      ) : null}

      {filesStore ? (
        <FilesDialog
          key={filesKey}
          state={filesState}
          store={filesStore}
          canManage={canManage}
          maxUploadBytes={view.maxUploadBytes}
          onStore={upsert}
        />
      ) : null}
    </div>
  );
}
