"use client";

import { useState, useTransition } from "react";
import { Button, Modal, Spinner, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import { defaultGuardrails, guardrailsValid } from "@/lib/gateway/guardrails";
import { isActionFail } from "@/lib/http/action-result";
import type { GuardrailOverrideView, GuardrailPolicy, PolicyScope, PolicyTarget } from "@/types/guardrails";
import { saveGuardrailOverrideAction } from "../_action";
import GuardrailPolicyFields from "./guardrail-policy-fields";
import PolicyTargetPicker from "./policy-target-picker";

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
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
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
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result);
      toast(t("overrideSaved", { mode: "saved" }), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-3xl">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("overrideTitle", { mode: editing ? "edit" : "create" })}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <p className="text-sm text-muted">{t("content.overrideHint")}</p>
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
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!targetId || !guardrailsValid(policy)}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("saveOverride")}
                      </>
                    )}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
