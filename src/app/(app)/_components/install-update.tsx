"use client";

import { Button, Spinner } from "@heroui/react";
import { ArrowUpCircle, Download } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import IconTile from "@/components/console/icon-tile";
import { shortDigest } from "@/lib/updates/updater-view";
import type { UpdaterView } from "@/types/updates";
import { useUpdaterRequest } from "./updater-controls";

export default function InstallUpdate({
  updater,
  canManage,
  installing,
  latest,
  collapsed,
  onView,
}: {
  updater: UpdaterView;
  canManage: boolean;
  installing: boolean;
  latest: string | null;
  collapsed: boolean;
  onView: (view: UpdaterView | null) => void;
}) {
  const t = useTranslations("Common");
  const { request, installing: requesting } = useUpdaterRequest(onView);
  const busy = installing || requesting || updater.pending === "update";
  const subtitle = busy ? t("updater.installing") : (latest ?? shortDigest(updater.latestDigest));

  const trigger = collapsed ? (
    <Button isIconOnly size="sm" variant="secondary" aria-label={t("updater.installLabel")} isPending={busy}>
      {({ isPending }) => (isPending ? <Spinner size="sm" color="current" /> : <Download size={14} aria-hidden />)}
    </Button>
  ) : (
    <Button size="sm" variant="secondary" isPending={busy}>
      {({ isPending }) => (
        <>
          {isPending ? <Spinner size="sm" color="current" /> : null}
          {t("updater.install")}
        </>
      )}
    </Button>
  );

  const action = canManage ? (
    <ConfirmDialog
      title={t("updater.updateTitle")}
      description={t("updater.updateDescription")}
      confirmLabel={t("updater.updateConfirm")}
      cancelLabel={t("cancel")}
      pending={requesting}
      onConfirm={() => request("update")}
    >
      {trigger}
    </ConfirmDialog>
  ) : null;

  if (collapsed) {
    return action ? (
      <div className="flex justify-center">{action}</div>
    ) : (
      <div className="flex justify-center" title={t("version.updateAvailable")}>
        <IconTile icon={ArrowUpCircle} tone="accent" size="sm" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 px-2 py-1">
      <IconTile icon={ArrowUpCircle} tone="accent" size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{t("version.updateAvailable")}</span>
        <span className="block truncate text-xs text-muted">{subtitle}</span>
      </span>
      {action}
    </div>
  );
}
