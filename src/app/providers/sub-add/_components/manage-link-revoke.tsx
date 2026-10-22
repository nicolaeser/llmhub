"use client";

import { Button, Spinner } from "@heroui/react";
import { ShieldOff } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";

export default function ManageLinkRevoke({
  label,
  variant,
  pending,
  isDisabled = false,
  onConfirm,
}: {
  label: string;
  variant: "danger-soft" | "ghost";
  pending: boolean;
  isDisabled?: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations("SubAdd.manage");
  const tCommon = useTranslations("Common");
  return (
    <ConfirmDialog
      title={t("revokeTitle")}
      description={t("revokeDescription")}
      confirmLabel={t("revokeConfirm")}
      cancelLabel={tCommon("cancel")}
      focusCancel
      pending={pending}
      onConfirm={onConfirm}
    >
      <Button size="sm" variant={variant} isPending={pending} isDisabled={isDisabled}>
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : <ShieldOff size={14} aria-hidden />}
            {label}
          </>
        )}
      </Button>
    </ConfirmDialog>
  );
}
