"use client";

import { useState, useTransition } from "react";
import { toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import { isActionFail } from "@/lib/http/action-result";
import type { ProviderKindSpec, ProviderView } from "@/types/providers";
import { createProviderAction, updateProviderAction } from "../_action";
import { draftBody, draftFor, draftReady } from "./provider-draft";
import ProviderFields from "./provider-fields";

function poolOf(spec: ProviderKindSpec, internal: boolean) {
  if (isSignInKind(spec.kind)) return "subscription";
  return internal ? "internal" : "api";
}

export default function ProviderDialog({
  state,
  spec,
  editing,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  spec: ProviderKindSpec | null;
  editing: ProviderView | null;
  onSaved: (provider: ProviderView, superseded: string[]) => void;
}) {
  const t = useTranslations("Providers");
  const showError = useErrorToast();
  const [draft, setDraft] = useState(() => draftFor(spec, editing, spec ? t("kindName", { kind: spec.kind }) : ""));
  const [pending, start] = useTransition();

  function save(close: () => void) {
    if (!spec) return;
    const body = draftBody(spec, draft);
    start(async () => {
      const result = editing ? await updateProviderAction({ id: editing.id, ...body }) : await createProviderAction(body);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.provider, result.superseded);
      toast(t("toasts.saved", { mode: result.outcome }), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      title={t("formTitle", {
        mode: editing ? "edit" : "connect",
        name: spec ? t("kindName", { kind: spec.kind }) : (editing?.name ?? ""),
      })}
      description={spec ? t("poolHint", { pool: poolOf(spec, draft.internal) }) : undefined}
      submitLabel={t("formSubmit", { mode: editing ? "save" : "connect" })}
      pending={pending}
      isSubmitDisabled={!draftReady(spec, editing, draft)}
      onSubmit={save}
    >
      {spec ? <ProviderFields spec={spec} editing={editing} draft={draft} isDisabled={pending} onChange={setDraft} /> : null}
    </FormDialog>
  );
}
