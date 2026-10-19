"use client";

import { useState, useTransition } from "react";
import { Alert, Card, Chip, Disclosure, toast } from "@heroui/react";
import { Shield } from "lucide-react";
import { useTranslations } from "next-intl";
import FormActions from "@/components/console/form-actions";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import StatCard from "@/components/console/stat-card";
import { useErrorToast } from "@/components/console/use-error-toast";
import { guardrailsValid } from "@/lib/gateway/safety/guardrails";
import { defaultEntityIds } from "@/lib/gateway/safety/pii";
import { useActionData } from "@/lib/hooks/use-action-data";
import { loadGuardrailsAction, saveGuardrailPolicyAction, savePiiAction } from "./_action";
import GuardrailOverrides from "./_components/guardrail-overrides";
import GuardrailPolicyFields from "./_components/guardrail-policy-fields";
import GuardrailTester from "./_components/guardrail-tester";
import PiiEntityPicker from "./_components/pii-entity-picker";
import PiiOverrides from "./_components/pii-overrides";
import PiiPolicyFields from "./_components/pii-policy-fields";
import PiiTester from "./_components/pii-tester";
import { isActionFail } from "@/lib/http/action-result";
import type { GuardrailPolicy, PiiPolicy, PolicyScope, PolicyTarget } from "@/types/guardrails";

function withDefaults(policy: PiiPolicy): PiiPolicy {
  return policy.entities.length ? policy : { ...policy, entities: defaultEntityIds() };
}

function byAlias(a: PolicyTarget, b: PolicyTarget) {
  return a.alias.localeCompare(b.alias);
}

function replaceOverride<V extends PolicyTarget>(
  current: V[],
  result: { scope: PolicyScope; id: string; override: V | null },
): V[] {
  const next = result.override;
  return [
    ...current.filter((row) => row.scope !== result.scope || row.id !== result.id),
    ...(next ? [next] : []),
  ].sort(byAlias);
}

export default function GuardrailsPage() {
  const t = useTranslations("Guardrails");
  const showError = useErrorToast();
  const tCommon = useTranslations("Common");
  const [policyDraft, setPolicy] = useState<PiiPolicy | null>(null);
  const [guardrailsDraft, setGuardrails] = useState<GuardrailPolicy | null>(null);
  const [pending, start] = useTransition();
  const page = useActionData(loadGuardrailsAction);
  const { data, setData } = page;

  if (!data) {
    return <PageStatus icon={Shield} title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  const { canManage, targets, piiOverrides, guardrailOverrides } = data;
  const saved = withDefaults(data.pii);
  const savedGuardrails = data.guardrails;
  const policy = policyDraft ?? saved;
  const guardrails = guardrailsDraft ?? savedGuardrails;
  const piiDirty = policyDraft !== null;
  const contentDirty = guardrailsDraft !== null;

  function savePii() {
    start(async () => {
      const result = await savePiiAction(policy);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData((current) => ({ ...current, pii: result.pii }));
      setPolicy(null);
      toast(t("saved"), { variant: "success" });
    });
  }

  function saveContent() {
    start(async () => {
      const result = await saveGuardrailPolicyAction(guardrails);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData((current) => ({ ...current, guardrails: result.guardrails }));
      setGuardrails(null);
      toast(t("content.saved"), { variant: "success" });
    });
  }

  const injectionOn = guardrails.injection.enabled;
  const secretsOn = guardrails.secrets.enabled;
  const rulesCount = guardrails.rules.length;

  return (
    <div className="space-y-5">
      <PageHeader icon={Shield} title={t("title")} subtitle={t("subtitle")} />

      <PageTabs
        label={t("title")}
        tabs={[
          {
            id: "pii",
            label: t("tabs", { tab: "pii" }),
            panel: (
              <div className="space-y-4 sm:space-y-5">
                <div className="grid gap-3 sm:grid-cols-3">
                  <StatCard
                    label={t("policy")}
                    value={t("enabledState", { enabled: policy.enabled ? "true" : "false" })}
                    tone={policy.enabled ? "success" : "neutral"}
                  />
                  <StatCard label={t("mode")} value={t("modeState", { state: policy.enabled ? policy.mode : "off" })} tone="accent" />
                  <StatCard
                    label={t("entities")}
                    value={t("entityCount", { count: policy.entities.length })}
                    hint={piiDirty ? tCommon("unsaved") : undefined}
                    tone={piiDirty ? "warning" : "neutral"}
                  />
                </div>

                <Card className="gap-4">
                  <Card.Header className="flex-row flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Card.Title>{t("policy")}</Card.Title>
                      <Card.Description>{t("policyHint")}</Card.Description>
                    </div>
                    <Chip size="sm" variant="soft" color={policy.enabled ? "success" : "warning"}>
                      {t("enabledState", { enabled: policy.enabled ? "true" : "false" })}
                    </Chip>
                  </Card.Header>
                  <Card.Content>
                    <PiiPolicyFields value={policy} onChange={setPolicy} isDisabled={!canManage} />
                  </Card.Content>
                </Card>

                <Alert status="accent">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{t("logsHint")}</Alert.Description>
                  </Alert.Content>
                </Alert>

                <PiiOverrides
                  overrides={piiOverrides}
                  targets={targets}
                  global={saved}
                  canManage={canManage}
                  onChanged={(result) =>
                    setData((current) => ({ ...current, piiOverrides: replaceOverride(current.piiOverrides, result) }))
                  }
                />

                <Card>
                  <Disclosure>
                    <Disclosure.Heading>
                      <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                        {tCommon("advanced")}
                        <Disclosure.Indicator />
                      </Disclosure.Trigger>
                    </Disclosure.Heading>
                    <Disclosure.Content>
                      <Disclosure.Body className="flex flex-col gap-4 pt-4">
                        <PiiEntityPicker
                          value={policy.entities}
                          onChange={(entities) => setPolicy({ ...policy, entities })}
                          isDisabled={!canManage}
                          wide
                        />
                        <PiiTester />
                      </Disclosure.Body>
                    </Disclosure.Content>
                  </Disclosure>
                </Card>
                {canManage ? <FormActions label={t("save")} pending={pending} onSave={savePii} /> : null}
              </div>
            ),
          },
          {
            id: "content",
            label: t("tabs", { tab: "content" }),
            panel: (
              <div className="space-y-4 sm:space-y-5">
                <div className="grid gap-3 sm:grid-cols-3">
                  <StatCard
                    label={t("injection.title")}
                    value={t("content.state", { enabled: String(injectionOn), action: guardrails.injection.action })}
                    tone={injectionOn ? "success" : "neutral"}
                  />
                  <StatCard
                    label={t("secrets.title")}
                    value={t("content.state", { enabled: String(secretsOn), action: guardrails.secrets.action })}
                    tone={secretsOn ? "success" : "neutral"}
                  />
                  <StatCard
                    label={t("rules.title")}
                    value={t("rules.count", { count: rulesCount })}
                    hint={contentDirty ? tCommon("unsaved") : undefined}
                    tone={contentDirty ? "warning" : "neutral"}
                  />
                </div>

                <Card className="gap-4">
                  <Card.Header>
                    <Card.Title>{t("content.policy")}</Card.Title>
                    <Card.Description>{t("content.policyHint")}</Card.Description>
                  </Card.Header>
                  <Card.Content>
                    <GuardrailPolicyFields value={guardrails} onChange={setGuardrails} isDisabled={!canManage} />
                  </Card.Content>
                </Card>

                <Alert status="accent">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{t("content.logsHint")}</Alert.Description>
                    <Alert.Description>{t("content.streamHint")}</Alert.Description>
                  </Alert.Content>
                </Alert>

                <GuardrailOverrides
                  overrides={guardrailOverrides}
                  targets={targets}
                  global={savedGuardrails}
                  canManage={canManage}
                  onChanged={(result) =>
                    setData((current) => ({
                      ...current,
                      guardrailOverrides: replaceOverride(current.guardrailOverrides, result),
                    }))
                  }
                />

                <GuardrailTester policy={guardrails} />
                {canManage ? (
                  <FormActions
                    label={t("save")}
                    pending={pending}
                    isDisabled={!guardrailsValid(guardrails)}
                    onSave={saveContent}
                  />
                ) : null}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
