"use client";

import { useState, useTransition } from "react";
import {
  ComboBox,
  Description,
  Input,
  Label,
  ListBox,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { assignCatalogEntryAction } from "../_action";
import { isActionFail } from "@/lib/http/action-result";
import type { CatalogEntryView, CatalogView } from "@/types/model-catalog";
import { useErrorToast } from "@/components/console/use-error-toast";
import FormDialog from "@/components/console/form-dialog";

export default function AssignDialog({
  state,
  entry,
  current,
  aliases,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  entry: CatalogEntryView | null;
  current: string;
  aliases: string[];
  onSaved: (view: CatalogView) => void;
}) {
  const t = useTranslations("ModelCatalog");
  const showError = useErrorToast();
  const [alias, setAlias] = useState(current);
  const [pending, start] = useTransition();
  const target = alias.trim().toLowerCase();

  function save(close: () => void) {
    if (!entry) return;
    start(async () => {
      const result = await assignCatalogEntryAction({
        providerId: entry.providerId,
        upstreamId: entry.upstreamId,
        alias: target,
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result);
      toast(t("saved"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="sm"
      title={t("assignTitle", { model: entry?.upstreamId ?? "" })}
      submitLabel={t("assignSubmit")}
      pending={pending}
      isSubmitDisabled={!entry || !target || target === current}
      onSubmit={save}
    >
      <ComboBox
        fullWidth
        allowsCustomValue
        inputValue={alias}
        onInputChange={setAlias}
        onSelectionChange={(key) => {
          if (key !== null) setAlias(String(key));
        }}
        isDisabled={pending}
      >
        <Label>{t("assignAlias")}</Label>
        <ComboBox.InputGroup>
          <Input />
          <ComboBox.Trigger />
        </ComboBox.InputGroup>
        <Description>{t("assignHint")}</Description>
        <ComboBox.Popover>
          <ListBox aria-label={t("assignAlias")}>
            {aliases.map((option) => (
              <ListBox.Item key={option} id={option} textValue={option}>
                <span className="font-mono text-sm">{option}</span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </ComboBox.Popover>
      </ComboBox>
    </FormDialog>
  );
}
