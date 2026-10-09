"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Alert, Button, Chip, SearchField, Spinner, Table, toast, useOverlayState } from "@heroui/react";
import { FolderOpen, Library, Pencil, Plus, Trash2 } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import SearchSelect from "@/components/console/search-select";
import { deleteKnowledgeAction, loadKnowledgeAction } from "@/app/(app)/knowledge/_action";
import { isActionFail } from "@/lib/http/action-result";
import { formatBytes } from "@/lib/utils/bytes";
import type { KnowledgeView, VectorStoreStatus, VectorStoreView } from "@/types/rag";
import FilesDialog from "./_components/files-dialog";
import StoreDialog from "./_components/store-dialog";

const ALL_COMPANIES = ":all";

const STATUS_COLOR = {
  in_progress: "warning",
  completed: "success",
  expired: "default",
} as const satisfies Record<VectorStoreStatus, "warning" | "success" | "default">;

function ownerName(store: VectorStoreView): string {
  if (store.scope === "project") return store.projectName;
  if (store.scope === "member") return store.memberName;
  if (store.scope === "user") return store.userName;
  return "";
}

export default function KnowledgePage() {
  const t = useTranslations("Knowledge");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<KnowledgeView | null>(null);
  const [stores, setStores] = useState<VectorStoreView[]>([]);
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

  useEffect(() => {
    loadKnowledgeAction().then((res) => {
      if (!isActionFail(res)) {
        setView(res);
        setStores(res.stores);
      }
      setLoading(false);
    });
  }, []);

  const upsert = useCallback((store: VectorStoreView) => {
    setStores((current) =>
      current.some((row) => row.id === store.id)
        ? current.map((row) => (row.id === store.id ? store : row))
        : [store, ...current],
    );
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return stores.filter(
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
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      setStores((current) => current.filter((row) => row.id !== result.id));
      toast(t("toasts.deleted"), { variant: "success" });
    });
  }

  if (loading) {
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

  if (!view) {
    return (
      <div className="space-y-5">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{t("loadFailed")}</Alert.Description>
          </Alert.Content>
        </Alert>
      </div>
    );
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

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={stores.length ? createButton : undefined} />

      {canManage ? null : (
        <Alert status="accent">
          <Alert.Content>
            <Alert.Description>{t("readOnly")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {stores.length === 0 ? (
        <EmptyState icon={Library} title={t("emptyTitle")} description={t("empty")} action={createButton} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <SearchField
              value={query}
              onChange={setQuery}
              aria-label={t("search")}
              className="w-full max-w-sm"
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={t("search")} />
                <SearchField.ClearButton aria-label={tCommon("close")} />
              </SearchField.Group>
            </SearchField>
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
                className="w-full max-w-xs"
              />
            ) : null}
          </div>

          {filtered.length === 0 ? (
            <EmptyState icon={Library} title={t("noMatches")} />
          ) : (
            <Table aria-label={t("title")}>
              <Table.ScrollContainer>
                <Table.Content aria-label={t("title")} className="min-w-[64rem]">
                  <Table.Header>
                    <Table.Column isRowHeader>{t("columns.name")}</Table.Column>
                    <Table.Column>{t("columns.company")}</Table.Column>
                    <Table.Column>{t("columns.owner")}</Table.Column>
                    <Table.Column>{t("columns.status")}</Table.Column>
                    <Table.Column>{t("columns.files")}</Table.Column>
                    <Table.Column>{t("columns.size")}</Table.Column>
                    <Table.Column>{t("columns.embedding")}</Table.Column>
                    <Table.Column>{t("columns.lastActive")}</Table.Column>
                    <Table.Column>{tCommon("actions")}</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {filtered.map((store) => (
                      <Table.Row key={store.id} id={store.id}>
                        <Table.Cell>
                          <div className="font-medium">{store.name}</div>
                          {store.description ? (
                            <div className="text-xs text-muted">{store.description}</div>
                          ) : null}
                        </Table.Cell>
                        <Table.Cell>{store.orgName || tCommon("none")}</Table.Cell>
                        <Table.Cell>
                          <div className="text-sm">
                            {t("owner.name", { scope: store.scope, name: ownerName(store) })}
                          </div>
                          <div className="text-xs text-muted">{t("owner.kind", { scope: store.scope })}</div>
                        </Table.Cell>
                        <Table.Cell>
                          <Chip size="sm" variant="soft" color={STATUS_COLOR[store.status]}>
                            {t("status", { status: store.status })}
                          </Chip>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="text-sm">
                            {t("fileCounts", {
                              completed: store.fileCounts.completed,
                              total: store.fileCounts.total,
                            })}
                          </div>
                          {store.fileCounts.failed > 0 ? (
                            <div className="text-xs text-danger">
                              {t("failedCount", { count: store.fileCounts.failed })}
                            </div>
                          ) : null}
                        </Table.Cell>
                        <Table.Cell>{formatBytes(format, store.usageBytes)}</Table.Cell>
                        <Table.Cell>
                          <div className="font-mono text-xs">{store.embeddingModel}</div>
                          {store.embeddingDimensions > 0 ? (
                            <div className="text-xs text-muted">
                              {t("dimensions", { count: store.embeddingDimensions })}
                            </div>
                          ) : null}
                        </Table.Cell>
                        <Table.Cell>
                          <div className="text-sm">{format.relativeTime(new Date(store.lastActiveAt), now)}</div>
                          {store.expiresAt && store.status !== "expired" ? (
                            <div className="text-xs text-muted">
                              {t("expires", { when: format.relativeTime(new Date(store.expiresAt), now) })}
                            </div>
                          ) : null}
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex gap-1">
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={t("manageFiles")}
                              onPress={() => openFiles(store)}
                            >
                              <FolderOpen size={14} aria-hidden />
                            </Button>
                            {canManage ? (
                              <>
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="ghost"
                                  aria-label={tCommon("edit")}
                                  onPress={() => openDialog(store)}
                                >
                                  <Pencil size={14} aria-hidden />
                                </Button>
                                <ConfirmDialog
                                  title={t("deleteConfirm", { name: store.name })}
                                  description={t("deleteHint", { count: store.fileCounts.total })}
                                  confirmLabel={tCommon("delete")}
                                  cancelLabel={tCommon("cancel")}
                                  pending={deleting === store.id}
                                  onConfirm={() => remove(store.id)}
                                >
                                  <Button
                                    isIconOnly
                                    size="sm"
                                    variant="danger-soft"
                                    aria-label={tCommon("delete")}
                                    isPending={deleting === store.id}
                                  >
                                    <Trash2 size={14} aria-hidden />
                                  </Button>
                                </ConfirmDialog>
                              </>
                            ) : null}
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
        </>
      )}

      <StoreDialog
        key={dialogKey}
        state={formState}
        editing={editing}
        companies={view.companies}
        projects={view.projects}
        defaults={view.defaults}
        aliases={view.aliases}
        initialCompany={company === ALL_COMPANIES ? "" : company}
        onSaved={upsert}
      />

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
