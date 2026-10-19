"use client";

import { useState, useTransition } from "react";
import { toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import { saveAssignmentsAction } from "../_action";
import FormDialog from "@/components/console/form-dialog";
import { isActionFail } from "@/lib/http/action-result";
import type { AccessMode, ProviderView } from "@/types/providers";
import { useErrorToast } from "@/components/console/use-error-toast";
import AccessFields, { pickedFrom, pickedTargets, useAssignmentOptions } from "./access-fields";

export default function AccessDialog({
  state,
  provider,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  provider: ProviderView | null;
  onSaved: (provider: ProviderView) => void;
}) {
  const t = useTranslations("Subscriptions.access");
  const showError = useErrorToast();
  const [mode, setMode] = useState<AccessMode>(provider?.restricted ? "limited" : "open");
  const [picked, setPicked] = useState(() => pickedFrom(provider?.assignments ?? []));
  const [pending, start] = useTransition();
  const options = useAssignmentOptions(state.isOpen);

  function save(close: () => void) {
    if (!provider) return;
    start(async () => {
      const result = await saveAssignmentsAction({
        providerId: provider.id,
        restricted: mode === "limited",
        targets: pickedTargets(picked),
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved({ ...provider, restricted: result.restricted, assignments: result.assignments });
      toast(t("saved", { name: provider.name }), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      title={t("title", { name: provider?.name ?? "" })}
      description={t("description")}
      submitLabel={t("save")}
      pending={pending}
      isSubmitDisabled={!provider || (mode === "limited" && options === null)}
      onSubmit={save}
    >
      <AccessFields
        mode={mode}
        onModeChange={setMode}
        picked={picked}
        onPickedChange={setPicked}
        options={options}
        known={provider?.assignments ?? []}
        isDisabled={pending}
      />
    </FormDialog>
  );
}
