"use client";

import { useState, useTransition } from "react";
import { Card, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { ruleIssue } from "@/lib/gateway/safety/guardrails";
import { isActionFail } from "@/lib/http/action-result";
import type { GuardrailPolicy, GuardrailRule } from "@/types/guardrails";
import { saveGuardrailPolicyAction } from "../_action";
import RuleFields from "./rule-fields";
import { useRuleSummary } from "./rule-summary";
import { newRule, nextRuleName, upsertRule } from "./rule-view";

export default function RuleDialog({
  state,
  policy,
  editing,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  policy: GuardrailPolicy;
  editing: GuardrailRule | null;
  onSaved: (policy: GuardrailPolicy) => void;
}) {
  const t = useTranslations("Guardrails");
  const showError = useErrorToast();
  const summary = useRuleSummary();
  const [rule, setRule] = useState<GuardrailRule>(
    () => editing ?? newRule(nextRuleName(policy.rules, (n) => t("rules.defaultName", { n }))),
  );
  const [pending, start] = useTransition();
  const rules = upsertRule(policy.rules, rule);
  const invalid = Boolean(ruleIssue(rule, rules));

  function save(close: () => void) {
    start(async () => {
      const result = await saveGuardrailPolicyAction({ ...policy, rules });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.guardrails);
      toast(t("rules.saved", { mode: editing ? "edit" : "create" }), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="lg"
      title={t("rules.dialogTitle", { mode: editing ? "edit" : "create" })}
      description={t("rules.dialogHint")}
      submitLabel={t("rules.submit", { mode: editing ? "edit" : "create" })}
      pending={pending}
      isSubmitDisabled={invalid}
      onSubmit={save}
    >
      <RuleFields rule={rule} rules={policy.rules} onChange={setRule} isDisabled={pending} />
      <Card variant="secondary" className="gap-1">
        <Card.Description>{t("rules.preview")}</Card.Description>
        <p className="text-sm break-words text-foreground">{summary(rule)}</p>
      </Card>
    </FormDialog>
  );
}
