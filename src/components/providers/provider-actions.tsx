"use client";

import { useTransition } from "react";
import { Button, toast } from "@heroui/react";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { deleteProviderAction } from "@/app/(app)/providers/_action";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { isActionFail } from "@/lib/http/action-result";
import type { ProviderView } from "@/types/providers";
import { useErrorToast } from "@/components/console/use-error-toast";

export default function ProviderActions({
  row,
  onEdit,
  onImport,
  onDeleted,
}: {
  row: ProviderView;
  onEdit: (row: ProviderView) => void;
  onImport: (row: ProviderView) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="secondary" aria-label={t("edit", { name: row.name })} onPress={() => onEdit(row)}>
        {tCommon("edit")}
      </Button>
      <Button size="sm" variant="secondary" aria-label={tCommon("import")} onPress={() => onImport(row)}>
        {tCommon("import")}
      </Button>
      <ConfirmDialog
        title={tCommon("delete")}
        description={t("deleteConfirm", { name: row.name })}
        confirmLabel={tCommon("delete")}
        cancelLabel={tCommon("cancel")}
        pending={pending}
        onConfirm={() =>
          start(async () => {
            const result = await deleteProviderAction(row.id);
            if (isActionFail(result)) {
              showError(result.error);
              return;
            }
            onDeleted(result.id);
            toast(t("toasts.saved", { mode: "deleted" }), { variant: "success" });
          })
        }
      >
        <Button isIconOnly size="sm" variant="danger-soft" aria-label={tCommon("delete")} isPending={pending}>
          <Trash2 size={14} aria-hidden />
        </Button>
      </ConfirmDialog>
    </div>
  );
}
