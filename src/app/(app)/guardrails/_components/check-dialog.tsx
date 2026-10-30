"use client";

import { useState, useTransition } from "react";
import { Alert, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { GuardrailPolicy } from "@/types/guardrails";
import { saveGuardrailPolicyAction } from "../_action";
import InjectionFields from "./injection-fields";
import SecretsFields from "./secrets-fields";

export type CheckSection = "injection" | "secrets";

export default function CheckDialog({
  state,
  section,
  policy,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  section: CheckSection;
  policy: GuardrailPolicy;
  onSaved: (policy: GuardrailPolicy) => void;
}) {
  const t = useTranslations("Guardrails");
  const showError = useErrorToast();
  const [draft, setDraft] = useState(policy);
  const [pending, start] = useTransition();

  function save(close: () => void) {
    start(async () => {
      const result = await saveGuardrailPolicyAction({ ...policy, [section]: draft[section] });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.guardrails);
      toast(t("content.saved", { section }), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="xl"
      title={t("content.dialogTitle", { section })}
      description={t(`${section}.hint`)}
      submitLabel={t("content.save")}
      pending={pending}
      onSubmit={save}
    >
      {section === "injection" ? (
        <InjectionFields
          value={draft.injection}
          onChange={(injection) => setDraft({ ...draft, injection })}
          isDisabled={pending}
        />
      ) : (
        <>
          <SecretsFields
            value={draft.secrets}
            onChange={(secrets) => setDraft({ ...draft, secrets })}
            isDisabled={pending}
          />
          <Alert status="accent">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{t("content.streamHint")}</Alert.Description>
            </Alert.Content>
          </Alert>
        </>
      )}
    </FormDialog>
  );
}
