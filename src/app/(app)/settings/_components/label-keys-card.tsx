"use client";

import { toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { useErrorToast } from "@/components/console/use-error-toast";
import LabelKeysEditor from "@/components/usage/label-keys-editor";
import { savePlatformLabelKeysAction } from "../_action";
import { SettingSection } from "./setting-fields";

export default function LabelKeysCard({
  keys,
  canManage,
  onSaved,
}: {
  keys: string[];
  canManage: boolean;
  onSaved: (keys: string[]) => void;
}) {
  const t = useTranslations("Settings.logging.labels");
  const showError = useErrorToast();

  async function save(list: string[]) {
    const result = await savePlatformLabelKeysAction(list);
    if (isActionFail(result)) {
      showError(result.error);
      return false;
    }
    onSaved(result.keys);
    toast(t("saved"), { variant: "success" });
    return true;
  }

  return (
    <SettingSection title={t("title")} subtitle={t("hint")}>
      <LabelKeysEditor keys={keys} canManage={canManage} onSave={save} />
    </SettingSection>
  );
}
