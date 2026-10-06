"use client";

import { useEffect, useState, useTransition } from "react";
import { Alert, Button, Card, Chip, Disclosure, Spinner, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { defaultEntityIds } from "@/lib/gateway/pii";
import { loadGuardrailsAction, saveGuardrailsAction } from "./_action";
import PiiEntityPicker from "./_components/pii-entity-picker";
import PiiOverrides from "./_components/pii-overrides";
import PiiPolicyFields from "./_components/pii-policy-fields";
import PiiTester from "./_components/pii-tester";
import { isActionFail } from "@/lib/http/action-result";
import type { PiiOverrideView, PiiPolicy, PiiScope, PiiTarget } from "@/types/guardrails";

function withDefaults(policy: PiiPolicy): PiiPolicy {
  return policy.entities.length ? policy : { ...policy, entities: defaultEntityIds() };
}

function byAlias(a: PiiOverrideView, b: PiiOverrideView) {
  return a.alias.localeCompare(b.alias);
}

export default function GuardrailsPage() {
  const t = useTranslations("Guardrails");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [policy, setPolicy] = useState<PiiPolicy>({
    enabled: true,
    mode: "mask",
    output: true,
    entities: defaultEntityIds(),
  });
  const [saved, setSaved] = useState(policy);
  const [overrides, setOverrides] = useState<PiiOverrideView[]>([]);
  const [targets, setTargets] = useState<PiiTarget[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    loadGuardrailsAction().then((res) => {
      if (!isActionFail(res)) {
        setPolicy(withDefaults(res.pii));
        setSaved(withDefaults(res.pii));
        setOverrides(res.overrides);
        setTargets(res.targets);
        setCanManage(res.canManage);
      }
      setLoading(false);
    });
  }, []);

  function applyOverride(result: { scope: PiiScope; id: string; override: PiiOverrideView | null }) {
    const next = result.override;
    setOverrides((cur) =>
      [
        ...cur.filter((row) => row.scope !== result.scope || row.id !== result.id),
        ...(next ? [next] : []),
      ].sort(byAlias),
    );
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
              onPress={() =>
                start(async () => {
                  const result = await saveGuardrailsAction(policy);
                  if (isActionFail(result)) {
                    toast.danger(tError("code", { code: result.error }));
                    return;
                  }
                  setPolicy(result.pii);
                  setSaved(withDefaults(result.pii));
                  toast(t("saved"), { variant: "success" });
                })
              }
            >
              {t("save")}
            </Button>
          ) : undefined
        }
      />

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
        overrides={overrides}
        targets={targets}
        global={saved}
        canManage={canManage}
        onChanged={applyOverride}
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
    </div>
  );
}
