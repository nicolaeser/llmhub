"use client";

import { useState, useTransition } from "react";
import { toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import StepDialog from "@/components/console/step-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { defaultEntityIds } from "@/lib/gateway/safety/pii";
import { isActionFail } from "@/lib/http/action-result";
import type { PiiDetectorSettings, PiiPolicy } from "@/types/guardrails";
import type { FeatureModelChoice } from "@/types/models";
import { savePiiAction } from "../_action";
import PiiEntityPicker from "./pii-entity-picker";
import PiiModelFields from "./pii-model-fields";
import { PiiBehaviorFields, PiiDetectionFields } from "./pii-policy-fields";

function withDefaults(policy: PiiPolicy): PiiPolicy {
  return policy.entities.length ? policy : { ...policy, entities: defaultEntityIds() };
}

export default function PiiDialog({
  state,
  policy,
  detector,
  models,
  redactorConfigured,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  policy: PiiPolicy;
  detector: PiiDetectorSettings | null;
  models: FeatureModelChoice[];
  redactorConfigured: boolean;
  onSaved: (result: { pii: PiiPolicy; detector: PiiDetectorSettings }) => void;
}) {
  const t = useTranslations("Guardrails");
  const showError = useErrorToast();
  const [pii, setPii] = useState(() => withDefaults(policy));
  const [settings, setSettings] = useState(detector);
  const [pending, start] = useTransition();

  function save(close: () => void) {
    start(async () => {
      const result = await savePiiAction(pii, settings ?? undefined);
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
    <StepDialog
      state={state}
      size="xl"
      title={t("pii.dialogTitle")}
      description={t("pii.hint")}
      submitLabel={t("save")}
      pending={pending}
      onSubmit={save}
      steps={[
        {
          id: "behavior",
          title: t("pii.step", { step: "behavior" }),
          content: <PiiBehaviorFields value={pii} onChange={setPii} isDisabled={pending} />,
        },
        {
          id: "types",
          title: t("pii.step", { step: "types" }),
          description: t("pii.stepHint", { step: "types" }),
          optional: true,
          content: (
            <PiiEntityPicker
              value={pii.entities}
              onChange={(entities) => setPii({ ...pii, entities })}
              isDisabled={pending}
            />
          ),
        },
        {
          id: "detection",
          title: t("pii.step", { step: "detection" }),
          description: t("pii.stepHint", { step: "detection" }),
          optional: true,
          content: (
            <div className="space-y-5">
              <PiiDetectionFields value={pii} onChange={setPii} isDisabled={pending} />
              {settings ? (
                <PiiModelFields
                  value={settings}
                  onChange={setSettings}
                  models={models}
                  configured={redactorConfigured}
                  canManage
                />
              ) : null}
            </div>
          ),
        },
      ]}
    />
  );
}
