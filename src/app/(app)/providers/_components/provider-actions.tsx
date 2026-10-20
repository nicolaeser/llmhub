"use client";

import { useTransition } from "react";
import { Button, Dropdown, Spinner, toast, useOverlayState } from "@heroui/react";
import { Download, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { deleteProviderAction } from "../_action";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { isActionFail } from "@/lib/http/action-result";
import type { ProviderView } from "@/types/providers";
import { useErrorToast } from "@/components/console/use-error-toast";

export default function ProviderActions({
  row,
  variant = "buttons",
  onEdit,
  onImport,
  onDeleted,
}: {
  row: ProviderView;
  variant?: "buttons" | "menu";
  onEdit: (row: ProviderView) => void;
  onImport: (row: ProviderView) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [pending, start] = useTransition();
  const confirmState = useOverlayState();

  function remove() {
    start(async () => {
      const result = await deleteProviderAction(row.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onDeleted(result.id);
      toast(t("toasts.saved", { mode: "deleted" }), { variant: "success" });
    });
  }

  const confirm = (
    <ConfirmDialog
      state={variant === "menu" ? confirmState : undefined}
      title={tCommon("delete")}
      description={t("deleteConfirm", { name: row.name })}
      confirmLabel={tCommon("delete")}
      cancelLabel={tCommon("cancel")}
      pending={pending}
      onConfirm={remove}
    >
      {variant === "buttons" ? (
        <Button isIconOnly size="sm" variant="danger-soft" aria-label={tCommon("delete")} isPending={pending}>
          <Trash2 size={14} aria-hidden />
        </Button>
      ) : null}
    </ConfirmDialog>
  );

  if (variant === "menu") {
    return (
      <>
        <Dropdown>
          <Button isIconOnly size="sm" variant="tertiary" isPending={pending} aria-label={t("actions", { name: row.name })}>
            {({ isPending }) => (isPending ? <Spinner color="current" size="sm" /> : <MoreHorizontal size={14} aria-hidden />)}
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label={t("actions", { name: row.name })}
              onAction={(key) => {
                if (key === "edit") onEdit(row);
                if (key === "import") onImport(row);
                if (key === "delete") confirmState.open();
              }}
            >
              <Dropdown.Item id="edit" textValue={tCommon("edit")}>
                <Pencil size={14} aria-hidden />
                {tCommon("edit")}
              </Dropdown.Item>
              <Dropdown.Item id="import" textValue={t("importModels")}>
                <Download size={14} aria-hidden />
                {t("importModels")}
              </Dropdown.Item>
              <Dropdown.Item id="delete" textValue={tCommon("delete")} variant="danger">
                <Trash2 size={14} aria-hidden />
                {tCommon("delete")}
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        {confirm}
      </>
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="secondary" aria-label={t("edit", { name: row.name })} onPress={() => onEdit(row)}>
        {tCommon("edit")}
      </Button>
      <Button size="sm" variant="secondary" aria-label={tCommon("import")} onPress={() => onImport(row)}>
        {tCommon("import")}
      </Button>
      {confirm}
    </div>
  );
}
