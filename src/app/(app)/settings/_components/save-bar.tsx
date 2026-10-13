"use client";

import type { ReactNode } from "react";
import { Button, Spinner } from "@heroui/react";
import { useTranslations } from "next-intl";

export default function SaveBar({
  description,
  canManage,
  pending,
  isDisabled,
  onSave,
  extra,
}: {
  description: ReactNode;
  canManage: boolean;
  pending: boolean;
  isDisabled?: boolean;
  onSave: () => void;
  extra?: ReactNode;
}) {
  const t = useTranslations("Settings");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 flex-1 text-sm text-muted">{canManage ? description : t("readOnly")}</p>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          {extra}
          <Button isPending={pending} isDisabled={isDisabled} onPress={onSave}>
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : null}
                {t("save")}
              </>
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
