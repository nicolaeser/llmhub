"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import FormActions from "@/components/console/form-actions";

export function SettingsLead({ description, canManage }: { description: ReactNode; canManage: boolean }) {
  const t = useTranslations("Settings");
  return <p className="text-sm text-muted">{canManage ? description : t("readOnly")}</p>;
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
  return <FormActions label={t("save")} pending={pending} isDisabled={isDisabled} onSave={onSave} extra={extra} />;
}
