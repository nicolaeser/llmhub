"use client";

import { useEffect, useState, useTransition } from "react";
import { Alert, Button, Card, Chip, Disclosure, Spinner, Tabs, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { defaultGuardrails, guardrailsValid } from "@/lib/gateway/guardrails";
import { defaultEntityIds } from "@/lib/gateway/pii";
import { loadGuardrailsAction, saveGuardrailPolicyAction, savePiiAction } from "./_action";
import GuardrailOverrides from "./_components/guardrail-overrides";
import GuardrailPolicyFields from "./_components/guardrail-policy-fields";
import GuardrailTester from "./_components/guardrail-tester";
import PiiEntityPicker from "./_components/pii-entity-picker";
import PiiOverrides from "./_components/pii-overrides";
import PiiPolicyFields from "./_components/pii-policy-fields";
import PiiTester from "./_components/pii-tester";
import { isActionFail } from "@/lib/http/action-result";
import type {
  GuardrailOverrideView,
  GuardrailPolicy,
  PiiOverrideView,
  PiiPolicy,
  PolicyScope,
  PolicyTarget,
} from "@/types/guardrails";

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
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<GuardrailsTab>("pii");
  const [policy, setPolicy] = useState<PiiPolicy>({
    enabled: true,
    mode: "mask",
    output: true,
    entities: defaultEntityIds(),
  });
  const [saved, setSaved] = useState(policy);
  const [guardrails, setGuardrails] = useState<GuardrailPolicy>(defaultGuardrails);
  const [savedGuardrails, setSavedGuardrails] = useState<GuardrailPolicy>(defaultGuardrails);
  const [piiOverrides, setPiiOverrides] = useState<PiiOverrideView[]>([]);
  const [guardrailOverrides, setGuardrailOverrides] = useState<GuardrailOverrideView[]>([]);
  const [targets, setTargets] = useState<PolicyTarget[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    loadGuardrailsAction().then((res) => {
      if (!isActionFail(res)) {
        setPolicy(withDefaults(res.pii));
        setSaved(withDefaults(res.pii));
        setGuardrails(res.guardrails);
        setSavedGuardrails(res.guardrails);
        setPiiOverrides(res.piiOverrides);
        setGuardrailOverrides(res.guardrailOverrides);
        setTargets(res.targets);
        setCanManage(res.canManage);
      }
      setLoading(false);
    });
  }, []);

  function save() {
    start(async () => {
      if (tab === "pii") {
        const result = await savePiiAction(policy);
        if (isActionFail(result)) {
          toast.danger(tError("code", { code: result.error }));
          return;
        }
        setPolicy(result.pii);
        setSaved(withDefaults(result.pii));
        toast(t("saved"), { variant: "success" });
        return;
      }
      const result = await saveGuardrailPolicyAction(guardrails);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      setGuardrails(result.guardrails);
      setSavedGuardrails(result.guardrails);
      toast(t("content.saved"), { variant: "success" });
    });
  }

  if (loading) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
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
            onChanged={(result) => setPiiOverrides((cur) => replaceOverride(cur, result))}
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
                    onChange={(entities) => setPolicy((cur) => ({ ...cur, entities }))}
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
            onChanged={(result) => setGuardrailOverrides((cur) => replaceOverride(cur, result))}
          />

          <div className="mb-6">
            <GuardrailTester policy={guardrails} />
          </div>
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
