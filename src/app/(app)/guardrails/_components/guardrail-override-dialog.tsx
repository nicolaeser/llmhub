"use client";

import { useState, useTransition } from "react";
import { toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import { defaultGuardrails, guardrailsValid } from "@/lib/gateway/safety/guardrails";
import { isActionFail } from "@/lib/http/action-result";
import type { GuardrailOverrideView, GuardrailPolicy, PolicyScope, PolicyTarget } from "@/types/guardrails";
import { saveGuardrailOverrideAction } from "../_action";
import GuardrailPolicyFields from "./guardrail-policy-fields";
import PolicyTargetPicker from "./policy-target-picker";
import { useErrorToast } from "@/components/console/use-error-toast";
import FormDialog from "@/components/console/form-dialog";

export default function GuardrailOverrideDialog({
  state,
  editing,
  targets,
  inherited,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: GuardrailOverrideView | null;
  targets: PolicyTarget[];
  inherited: (target: PolicyTarget) => GuardrailPolicy;
  onSaved: (result: { scope: PolicyScope; id: string; override: GuardrailOverrideView | null }) => void;
}) {
  const t = useTranslations("Guardrails");
  const showError = useErrorToast();
  const [scope, setScope] = useState<PolicyScope>(() => editing?.scope ?? targets[0]?.scope ?? "org");
  const [targetId, setTargetId] = useState(
    () => editing?.id ?? targets.find((row) => row.scope === scope)?.id ?? "",
  );
  const [policy, setPolicy] = useState<GuardrailPolicy>(() => {
    if (editing) return editing.policy;
    const first = targets.find((row) => row.id === targetId);
    return first ? inherited(first) : defaultGuardrails();
  });
  const [pending, start] = useTransition();

  function pickTarget(id: string) {
    setTargetId(id);
    const target = targets.find((row) => row.id === id);
    if (target) setPolicy(inherited(target));
  }

  function save(close: () => void) {
    start(async () => {
      const result = await saveGuardrailOverrideAction({ scope, id: targetId, policy });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result);
      toast(t("overrideSaved", { mode: "saved" }), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="xl"
      title={t("overrideTitle", { mode: editing ? "edit" : "create" })}
      description={t("content.overrideHint")}
      submitLabel={t("saveOverride")}
      pending={pending}
      isSubmitDisabled={!targetId || !guardrailsValid(policy)}
      onSubmit={save}
    >
      {editing ? (
        <p className="text-sm">
          {t("overrideTarget", { scope: editing.scope, alias: editing.alias })}
        </p>
      ) : (
        <PolicyTargetPicker
          targets={targets}
          scope={scope}
          targetId={targetId}
          onScopeChange={(next) => {
            setScope(next);
            pickTarget(targets.find((row) => row.scope === next)?.id ?? "");
          }}
          onTargetChange={pickTarget}
          isDisabled={pending}
        />
      )}
      <GuardrailPolicyFields value={policy} onChange={setPolicy} isDisabled={pending} />
    </FormDialog>
  );
}
