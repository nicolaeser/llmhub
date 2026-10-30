"use client";

import { Button, Chip } from "@heroui/react";
import { FolderOpen, Pencil, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { useClock } from "@/lib/hooks/use-clock";
import type { VectorStoreStatus, VectorStoreView } from "@/types/rag";

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

export function StoreOwner({ store }: { store: VectorStoreView }) {
  const t = useTranslations("Knowledge");
  const tCommon = useTranslations("Common");
  return (
    <span className="text-xs break-words text-muted">
      {t("ownerLine", { company: store.orgName || tCommon("none"), scope: store.scope, name: ownerName(store) })}
    </span>
  );
}

export function StoreName({ store }: { store: VectorStoreView }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-sm font-medium break-words text-foreground">{store.name}</p>
      {store.description ? <p className="text-xs break-words text-muted">{store.description}</p> : null}
      <StoreOwner store={store} />
    </div>
  );
}

export function StoreStatusChip({ store }: { store: VectorStoreView }) {
  const t = useTranslations("Knowledge");
  return (
    <Chip size="sm" variant="soft" color={STATUS_COLOR[store.status]}>
      {t("status", { status: store.status })}
    </Chip>
  );
}

export function StoreFiles({ store }: { store: VectorStoreView }) {
  const t = useTranslations("Knowledge");
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-sm tabular-nums text-foreground">
        {t("fileCounts", { completed: store.fileCounts.completed, total: store.fileCounts.total })}
      </p>
      {store.fileCounts.in_progress > 0 ? (
        <p className="text-xs text-muted">{t("indexingCount", { count: store.fileCounts.in_progress })}</p>
      ) : null}
      {store.fileCounts.failed > 0 ? (
        <p className="text-xs text-danger">{t("failedCount", { count: store.fileCounts.failed })}</p>
      ) : null}
    </div>
  );
}

export function StoreActivity({ store }: { store: VectorStoreView }) {
  const t = useTranslations("Knowledge");
  const format = useFormatter();
  const now = useClock(30_000);
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-sm text-foreground">{format.relativeTime(new Date(store.lastActiveAt), now)}</p>
      {store.expiresAt && store.status !== "expired" ? (
        <p className="text-xs text-muted">{t("expires", { when: format.relativeTime(new Date(store.expiresAt), now) })}</p>
      ) : null}
    </div>
  );
}

export function StoreActions({
  store,
  canManage,
  deleting,
  onFiles,
  onEdit,
  onDelete,
}: {
  store: VectorStoreView;
  canManage: boolean;
  deleting: boolean;
  onFiles: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("Knowledge");
  const tCommon = useTranslations("Common");
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button size="sm" variant="secondary" onPress={onFiles} aria-label={t("filesFor", { name: store.name })}>
        <FolderOpen size={14} aria-hidden />
        {t("filesButton", { count: store.fileCounts.total })}
      </Button>
      {canManage ? (
        <>
          <Button isIconOnly size="sm" variant="ghost" aria-label={t("editFor", { name: store.name })} onPress={onEdit}>
            <Pencil size={14} aria-hidden />
          </Button>
          <ConfirmDialog
            title={t("deleteConfirm", { name: store.name })}
            description={t("deleteHint", { count: store.fileCounts.total })}
            confirmLabel={tCommon("delete")}
            cancelLabel={tCommon("cancel")}
            pending={deleting}
            onConfirm={onDelete}
          >
            <Button
              isIconOnly
              size="sm"
              variant="danger-soft"
              aria-label={t("deleteFor", { name: store.name })}
              isPending={deleting}
            >
              <Trash2 size={14} aria-hidden />
            </Button>
          </ConfirmDialog>
        </>
      ) : null}
    </div>
  );
}
