"use client";

import { useState, useTransition } from "react";
import { Description, Input, Label, TextField, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { createCompanyAction } from "../_action";

export default function AddCompanyDialog({
  state,
  onCreated,
}: {
  state: ReturnType<typeof useOverlayState>;
  onCreated: (company: { id: string; alias: string }) => void;
}) {
  const t = useTranslations("Companies.add");
  const showError = useErrorToast();
  const [alias, setAlias] = useState("");
  const [pending, start] = useTransition();

  function save(close: () => void) {
    start(async () => {
      const result = await createCompanyAction({ alias });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      toast(t("saved", { name: result.alias }), { variant: "success" });
      close();
      onCreated(result);
    });
  }

  return (
    <FormDialog
      state={state}
      size="sm"
      title={t("title")}
      description={t("hint")}
      submitLabel={t("submit")}
      pending={pending}
      isSubmitDisabled={!alias.trim()}
      onSubmit={save}
    >
      <TextField fullWidth isRequired autoFocus value={alias} onChange={setAlias} isDisabled={pending} maxLength={80}>
        <Label>{t("name")}</Label>
        <Input placeholder={t("placeholder")} />
        <Description>{t("nameHint")}</Description>
      </TextField>
    </FormDialog>
  );
}
