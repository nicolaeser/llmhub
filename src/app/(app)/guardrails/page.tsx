"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Card, Chip, Disclosure, Tabs, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
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

const TABS = ["pii", "content"] as const;

type GuardrailsTab = (typeof TABS)[number];

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
  const [tab, setTab] = useState<GuardrailsTab>("pii");
  const [policyDraft, setPolicy] = useState<PiiPolicy | null>(null);
  const [guardrailsDraft, setGuardrails] = useState<GuardrailPolicy | null>(null);
  const [pending, start] = useTransition();
  const page = useActionData(loadGuardrailsAction);
  const { data, setData } = page;

  if (!data) {
    return <PageStatus title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  const { canManage, targets, piiOverrides, guardrailOverrides } = data;
  const saved = withDefaults(data.pii);
  const savedGuardrails = data.guardrails;
  const policy = policyDraft ?? saved;
  const guardrails = guardrailsDraft ?? savedGuardrails;

  function save() {
    start(async () => {
      if (tab === "pii") {
        const result = await savePiiAction(policy);
        if (isActionFail(result)) {
          showError(result.error);
          return;
        }
        setData((current) => ({ ...current, pii: result.pii }));
        setPolicy(null);
        toast(t("saved"), { variant: "success" });
        return;
      }
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

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          canManage ? (
            <Button
              aria-label={t("save")}
              isPending={pending}
              isDisabled={tab === "content" && !guardrailsValid(guardrails)}
              onPress={save}
            >
              {t("save")}
            </Button>
          ) : undefined
        }
      />

      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => setTab(TABS.find((id) => id === key) ?? "pii")}
        aria-label={t("title")}
      >
        <Tabs.List className="mb-4 w-fit min-w-0" aria-label={t("title")}>
          {TABS.map((id) => (
            <Tabs.Tab key={id} id={id} className="w-auto">
              {t("tabs", { tab: id })}
            </Tabs.Tab>
          ))}
        </Tabs.List>

        <Tabs.Panel id="pii">
          <Card className="mb-6 gap-4">
            <Card.Header className="flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <Card.Title>{t("policy")}</Card.Title>
                <Card.Description>{t("policyHint")}</Card.Description>
              </div>
              <Chip size="sm" variant="soft" color={policy.enabled ? "success" : "warning"}>
                {t("enabledState", { enabled: policy.enabled ? "true" : "false" })}
              </Chip>
            </Card.Header>
            <PiiPolicyFields value={policy} onChange={setPolicy} isDisabled={!canManage} />
            <Alert status="accent">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{t("logsHint")}</Alert.Description>
              </Alert.Content>
            </Alert>
          </Card>

          <PiiOverrides
            overrides={piiOverrides}
            targets={targets}
            global={saved}
            canManage={canManage}
            onChanged={(result) =>
              setData((current) => ({ ...current, piiOverrides: replaceOverride(current.piiOverrides, result) }))
            }
          />

          <Card className="mb-6">
            <Disclosure>
              <Disclosure.Heading>
                <Disclosure.Trigger className="flex w-full items-center justify-between text-sm font-medium">
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
        </Tabs.Panel>

        <Tabs.Panel id="content">
          <Card className="mb-6 gap-4">
            <Card.Header>
              <Card.Title>{t("content.policy")}</Card.Title>
              <Card.Description>{t("content.policyHint")}</Card.Description>
            </Card.Header>
            <GuardrailPolicyFields value={guardrails} onChange={setGuardrails} isDisabled={!canManage} />
            <Alert status="accent">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{t("content.logsHint")}</Alert.Description>
                <Alert.Description>{t("content.streamHint")}</Alert.Description>
              </Alert.Content>
            </Alert>
          </Card>

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

          <div className="mb-6">
            <GuardrailTester policy={guardrails} />
          </div>
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
