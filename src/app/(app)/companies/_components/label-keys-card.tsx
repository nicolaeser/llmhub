"use client";

import { Card, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { useErrorToast } from "@/components/console/use-error-toast";
import LabelKeysEditor from "@/components/usage/label-keys-editor";
import { saveCompanyLabelKeysAction } from "../_action";
import type { StructurePayload } from "@/types/structure";

export default function LabelKeysCard({
  orgId,
  keys,
  inherited,
  canManage,
  onSaved,
}: {
  orgId: string;
  keys: string[];
  inherited: string[];
  canManage: boolean;
  onSaved: (payload: StructurePayload) => void;
}) {
  const t = useTranslations("Companies.labels");
  const showError = useErrorToast();

  async function save(list: string[]) {
    const result = await saveCompanyLabelKeysAction({ orgId, keys: list });
    if (isActionFail(result)) {
      showError(result.error);
      return false;
    }
    onSaved(result);
    toast(t("saved"), { variant: "success" });
    return true;
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>{t("hint")}</Card.Description>
      </Card.Header>
      <Card.Content>
        <LabelKeysEditor
          keys={keys}
          inherited={inherited.filter((key) => !keys.includes(key))}
          canManage={canManage}
          onSave={save}
        />
      </Card.Content>
    </Card>
  );
}
