"use client";

import type { ReactNode } from "react";
import { Button, Spinner } from "@heroui/react";
import { useTranslations } from "next-intl";

export function SettingsLead({ description, canManage }: { description: ReactNode; canManage: boolean }) {
  const t = useTranslations("Settings");
  return <p className="max-w-3xl text-sm text-muted">{canManage ? description : t("readOnly")}</p>;
}

export default function SaveBar({
  canManage,
  pending,
  isDisabled,
  onSave,
  extra,
}: {
  canManage: boolean;
  pending: boolean;
  isDisabled?: boolean;
  onSave: () => void;
  extra?: ReactNode;
}) {
  const t = useTranslations("Settings");
  if (!canManage) return null;
  return (
    <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end">
      {extra}
      <Button isPending={pending} isDisabled={isDisabled} onPress={onSave} className="w-full sm:w-auto">
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : null}
            {t("save")}
          </>
        )}
      </Button>
    </div>
  );
}
