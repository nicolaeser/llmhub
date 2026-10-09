"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Modal,
  Separator,
  Spinner,
  Table,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { RefreshCw, Trash2, Upload } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { listKnowledgeFilesAction, removeKnowledgeFileAction } from "@/app/(app)/knowledge/_action";
import { isActionFail } from "@/lib/http/action-result";
import { formatBytes } from "@/lib/utils/bytes";
import type { UploadItem, UploadStatus, VectorFileStatus, VectorFileView, VectorStoreView } from "@/types/rag";

const POLL_MS = 3000;

const ACCEPT = [
  ".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md", ".markdown", ".mdx", ".rst", ".adoc", ".tex", ".log",
  ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".ini", ".xml", ".rtf",
  ".html", ".htm", ".xhtml", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".go", ".java", ".kt", ".kts",
  ".scala", ".swift", ".rs", ".rb", ".php", ".py", ".r", ".lua", ".pl", ".sh", ".bash", ".ps1", ".sql",
  ".graphql", ".proto", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".vue", ".svelte",
  ".css", ".scss", ".less", ".dart", ".ex", ".exs", ".hs", ".clj", ".tf", ".hcl",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".avif",
].join(",");

const FILE_COLOR = {
  in_progress: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "default",
} as const satisfies Record<VectorFileStatus, "warning" | "success" | "danger" | "default">;

const UPLOAD_COLOR = {
  pending: "accent",
  done: "success",
  failed: "danger",
} as const satisfies Record<UploadStatus, "accent" | "success" | "danger">;

function problemCode(body: unknown): string {
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : "REQUEST_FAILED";
}

export default function FilesDialog({
  state,
  store,
  canManage,
  maxUploadBytes,
  onStore,
}: {
  state: ReturnType<typeof useOverlayState>;
  store: VectorStoreView;
  canManage: boolean;
  maxUploadBytes: number;
  onStore: (store: VectorStoreView) => void;
}) {
  const t = useTranslations("Knowledge");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const [files, setFiles] = useState<VectorFileView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [, startRemove] = useTransition();
  const picker = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const storeId = store.id;
  const open = state.isOpen;
  const processing = files.some((file) => file.status === "in_progress");
  const limit = formatBytes(format, maxUploadBytes);

  useEffect(() => {
    let active = true;
    listKnowledgeFilesAction(storeId).then((res) => {
      if (!active) return;
      setLoading(false);
      if (isActionFail(res)) {
        setLoadFailed(true);
        return;
      }
      setFiles(res.files);
      if (res.store) onStore(res.store);
    });
    return () => {
      active = false;
    };
  }, [storeId, onStore]);

  useEffect(() => {
    if (!open || !processing) return;
    let active = true;
    const timer = setInterval(() => {
      listKnowledgeFilesAction(storeId).then((res) => {
        if (!active || isActionFail(res)) return;
        setFiles(res.files);
        if (res.store) onStore(res.store);
      });
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, processing, storeId, onStore]);

  function refresh() {
    startRefresh(async () => {
      const res = await listKnowledgeFilesAction(storeId);
      if (isActionFail(res)) {
        toast.danger(tError("code", { code: res.error }));
        return;
      }
      setLoadFailed(false);
      setFiles(res.files);
      if (res.store) onStore(res.store);
    });
  }

  function mark(key: string, status: UploadStatus, error: string) {
    setUploads((current) => current.map((item) => (item.key === key ? { ...item, status, error } : item)));
  }

  async function uploadOne(key: string, file: File) {
    if (file.size > maxUploadBytes) {
      mark(key, "failed", "TOO_LARGE");
      return;
    }
    const body = new FormData();
    body.append("file", file);
    try {
      const res = await fetch(`/internal-api/knowledge/${encodeURIComponent(storeId)}/files`, {
        method: "POST",
        body,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        mark(key, "failed", problemCode(json));
        return;
      }
      const result = json as { store: VectorStoreView; files: VectorFileView[] };
      setFiles(result.files);
      onStore(result.store);
      mark(key, "done", "");
    } catch {
      mark(key, "failed", "NETWORK");
    }
  }

  function addFiles(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    const items: UploadItem[] = picked.map((file) => {
      sequence.current += 1;
      return { key: `upload-${sequence.current}`, name: file.name, status: "pending", error: "" };
    });
    setUploads((current) => [...items, ...current]);
    void (async () => {
      for (const [index, file] of picked.entries()) await uploadOne(items[index].key, file);
    })();
  }

  function remove(file: VectorFileView) {
    setRemoving(file.fileId);
    startRemove(async () => {
      const res = await removeKnowledgeFileAction(storeId, file.fileId);
      setRemoving(null);
      if (isActionFail(res)) {
        toast.danger(tError("code", { code: res.error }));
        return;
      }
      setFiles((current) => current.filter((row) => row.fileId !== res.fileId));
      onStore(res.store);
      toast(t("toasts.fileRemoved"), { variant: "success" });
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-3xl">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("files.title", { name: store.name })}</Modal.Heading>
                  <p className="text-sm text-muted">
                    {t("files.summary", {
                      total: store.fileCounts.total,
                      size: formatBytes(format, store.usageBytes),
                    })}
                  </p>
                </Modal.Header>
                <Modal.Body className="max-h-[70vh] space-y-4 overflow-y-auto">
                  {canManage ? (
                    <Card
                      variant="secondary"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        addFiles(event.dataTransfer.files);
                      }}
                    >
                      <Card.Header>
                        <Card.Title>{t("upload.title")}</Card.Title>
                        <Card.Description>{t("upload.hint", { limit })}</Card.Description>
                      </Card.Header>
                      <Card.Footer>
                        <input
                          ref={picker}
                          type="file"
                          multiple
                          accept={ACCEPT}
                          tabIndex={-1}
                          aria-hidden
                          className="sr-only"
                          onChange={(event) => {
                            const picked = event.currentTarget.files;
                            addFiles(picked);
                            event.currentTarget.value = "";
                          }}
                        />
                        <Button variant="secondary" onPress={() => picker.current?.click()}>
                          <Upload size={16} aria-hidden />
                          {t("upload.choose")}
                        </Button>
                      </Card.Footer>
                    </Card>
                  ) : null}

                  {uploads.length ? (
                    <section aria-label={t("upload.queue")} className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-foreground">{t("upload.queue")}</p>
                        <Button
                          size="sm"
                          variant="ghost"
                          isDisabled={uploads.every((item) => item.status === "pending")}
                          onPress={() => setUploads((current) => current.filter((item) => item.status === "pending"))}
                        >
                          {t("upload.clear")}
                        </Button>
                      </div>
                      <ul className="divide-y divide-border" aria-live="polite">
                        {uploads.map((item) => (
                          <li key={item.key} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                            <div className="min-w-0 flex-1">
                              <p className="break-all text-foreground">{item.name}</p>
                              {item.status === "failed" ? (
                                <p className="text-xs text-danger">{t("upload.error", { code: item.error, limit })}</p>
                              ) : null}
                            </div>
                            <Chip size="sm" variant="soft" color={UPLOAD_COLOR[item.status]}>
                              {item.status === "pending" ? <Spinner size="sm" color="current" /> : null}
                              {t("upload.status", { status: item.status })}
                            </Chip>
                          </li>
                        ))}
                      </ul>
                      <Separator />
                    </section>
                  ) : null}

                  {processing ? (
                    <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
                      <Spinner size="sm" color="current" />
                      {t("files.processing")}
                    </p>
                  ) : null}

                  {loading ? (
                    <output
                      aria-live="polite"
                      aria-label={tCommon("loading")}
                      className="flex min-h-32 items-center justify-center text-accent"
                    >
                      <Spinner color="current" />
                    </output>
                  ) : loadFailed ? (
                    <Alert status="danger">
                      <Alert.Content>
                        <Alert.Description>{t("files.loadFailed")}</Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : files.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted">{t("files.empty")}</p>
                  ) : (
                    <Table aria-label={t("files.title", { name: store.name })}>
                      <Table.ScrollContainer>
                        <Table.Content aria-label={t("files.title", { name: store.name })} className="min-w-[40rem]">
                          <Table.Header>
                            <Table.Column isRowHeader>{t("files.columns.name")}</Table.Column>
                            <Table.Column>{t("files.columns.status")}</Table.Column>
                            <Table.Column>{t("files.columns.chunks")}</Table.Column>
                            <Table.Column>{t("files.columns.size")}</Table.Column>
                            <Table.Column>{t("files.columns.created")}</Table.Column>
                            <Table.Column>{tCommon("actions")}</Table.Column>
                          </Table.Header>
                          <Table.Body>
                            {files.map((file) => (
                              <Table.Row key={file.fileId} id={file.fileId}>
                                <Table.Cell>
                                  <div className="break-all font-medium">{file.filename}</div>
                                  {file.error ? (
                                    <div className="space-y-0.5">
                                      <p className="text-xs text-danger">{t("files.error", { code: file.error.code })}</p>
                                      <p className="break-words text-xs text-muted">{file.error.message}</p>
                                    </div>
                                  ) : null}
                                </Table.Cell>
                                <Table.Cell>
                                  <Chip size="sm" variant="soft" color={FILE_COLOR[file.status]}>
                                    {t("files.status", { status: file.status })}
                                  </Chip>
                                </Table.Cell>
                                <Table.Cell>{format.number(file.chunkCount, "integer")}</Table.Cell>
                                <Table.Cell>{formatBytes(format, file.usageBytes)}</Table.Cell>
                                <Table.Cell>{format.relativeTime(new Date(file.createdAt), now)}</Table.Cell>
                                <Table.Cell>
                                  {canManage ? (
                                    <ConfirmDialog
                                      title={t("files.removeConfirm", { name: file.filename })}
                                      description={t("files.removeHint")}
                                      confirmLabel={t("files.remove")}
                                      cancelLabel={tCommon("cancel")}
                                      pending={removing === file.fileId}
                                      onConfirm={() => remove(file)}
                                    >
                                      <Button
                                        isIconOnly
                                        size="sm"
                                        variant="danger-soft"
                                        aria-label={t("files.remove")}
                                        isPending={removing === file.fileId}
                                      >
                                        <Trash2 size={14} aria-hidden />
                                      </Button>
                                    </ConfirmDialog>
                                  ) : null}
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table.Content>
                      </Table.ScrollContainer>
                    </Table>
                  )}
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="secondary" isPending={refreshing} onPress={refresh}>
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={16} aria-hidden />}
                        {t("files.refresh")}
                      </>
                    )}
                  </Button>
                  <Button variant="tertiary" onPress={close}>
                    {tCommon("close")}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
