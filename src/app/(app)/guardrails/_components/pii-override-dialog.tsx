"use client";

import { useState, useTransition } from "react";
import { Button, Modal, Spinner, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import type { PiiOverrideView, PiiPolicy, PolicyScope, PolicyTarget } from "@/types/guardrails";
import { savePiiOverrideAction } from "../_action";
import PiiEntityPicker from "./pii-entity-picker";
import PiiPolicyFields from "./pii-policy-fields";
import PolicyTargetPicker from "./policy-target-picker";
import { useErrorToast } from "@/components/console/use-error-toast";

export default function PiiOverrideDialog({
  state,
  editing,
  targets,
  inherited,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: PiiOverrideView | null;
  targets: PolicyTarget[];
  inherited: (target: PolicyTarget) => PiiPolicy;
  onSaved: (result: { scope: PolicyScope; id: string; override: PiiOverrideView | null }) => void;
}) {
  const t = useTranslations("Guardrails");
  const showError = useErrorToast();
  const tCommon = useTranslations("Common");
  const [scope, setScope] = useState<PolicyScope>(() => editing?.scope ?? targets[0]?.scope ?? "org");
  const [targetId, setTargetId] = useState(
    () => editing?.id ?? targets.find((row) => row.scope === scope)?.id ?? "",
  );
  const [policy, setPolicy] = useState<PiiPolicy>(() => {
    if (editing) return editing.policy;
    const first = targets.find((row) => row.id === targetId);
    return first ? inherited(first) : { enabled: true, mode: "mask", output: true, entities: [] };
  });
  const [pending, start] = useTransition();

  function pickTarget(id: string) {
    setTargetId(id);
    const target = targets.find((row) => row.id === id);
    if (target) setPolicy(inherited(target));
  }

  function save(close: () => void) {
    start(async () => {
      const result = await savePiiOverrideAction({ scope, id: targetId, policy });
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
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-2xl">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("overrideTitle", { mode: editing ? "edit" : "create" })}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <p className="text-sm text-muted">{t("overrideHint")}</p>
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
                  <PiiPolicyFields value={policy} onChange={setPolicy} isDisabled={pending} />
                  <PiiEntityPicker
                    value={policy.entities}
                    onChange={(entities) => setPolicy((cur) => ({ ...cur, entities }))}
                    isDisabled={pending}
                  />
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button isPending={pending} isDisabled={!targetId} onPress={() => save(close)}>
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
