"use client";

import { useState, useTransition } from "react";
import { Alert, Card, Chip, Disclosure, toast, useOverlayState } from "@heroui/react";
import { Shield } from "lucide-react";
import { useTranslations } from "next-intl";
import FormActions from "@/components/console/form-actions";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import { useErrorToast } from "@/components/console/use-error-toast";
import { guardrailsValid } from "@/lib/gateway/safety/guardrails";
import { defaultEntityIds } from "@/lib/gateway/safety/pii";
import { refKey } from "@/lib/gateway/safety/policy-layers";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { GuardrailPolicy, PiiDetectorSettings, PiiPolicy, PolicyOverrideView, PolicyRef } from "@/types/guardrails";
import { useConsoleScope } from "../_components/console-scope";
import {
  loadGuardrailsAction,
  removePolicyOverrideAction,
  saveGuardrailPolicyAction,
  savePiiAction,
} from "./_action";
import GuardrailRules from "./_components/guardrail-rules";
import InjectionFields from "./_components/injection-fields";
import OverrideDialog from "./_components/override-dialog";
import PiiEntityPicker from "./_components/pii-entity-picker";
import PiiModelFields from "./_components/pii-model-fields";
import PiiPolicyFields from "./_components/pii-policy-fields";
import PolicyOverrides from "./_components/policy-overrides";
import PolicyTester from "./_components/policy-tester";
import { replaceOverride, sortOverrides, type PolicyBook } from "./_components/policy-view";
import SecretsFields from "./_components/secrets-fields";

function withDefaults(policy: PiiPolicy): PiiPolicy {
  return policy.entities.length ? policy : { ...policy, entities: defaultEntityIds() };
}

type DialogTarget = { editing: PolicyOverrideView | null; key: number };

export default function GuardrailsPage() {
  const t = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [piiDraft, setPii] = useState<PiiPolicy | null>(null);
  const [detectorDraft, setDetector] = useState<PiiDetectorSettings | null>(null);
  const [guardrailsDraft, setGuardrails] = useState<GuardrailPolicy | null>(null);
  const [dialog, setDialog] = useState<DialogTarget>({ editing: null, key: 0 });
  const [pending, start] = useTransition();
  const dialogState = useOverlayState();
  const page = useActionData(loadGuardrailsAction);
  const { data, setData } = page;
  const { kind } = useConsoleScope();

  if (!data) {
    const loadingSubtitle = kind === "company" ? t("companySubtitle") : t("subtitle");
    return (
      <PageStatus
        icon={Shield}
        title={t("title")}
        subtitle={loadingSubtitle}
        state={page}
        tabs
        layout={kind === "company" ? "table" : "form"}
      />
    );
  }

  const { canManage, platform, models, redactorConfigured } = data;
  const canEditPlatform = canManage && platform;
  const overrides = sortOverrides(data.overrides);
  const book: PolicyBook = {
    platform: { pii: data.pii, guardrails: data.guardrails },
    overrides,
    targets: data.targets,
  };
  const pii = piiDraft ?? withDefaults(data.pii);
  const guardrails = guardrailsDraft ?? data.guardrails;
  const detector = detectorDraft ?? data.detector;
  const piiDirty = piiDraft !== null || detectorDraft !== null;
  const contentDirty = guardrailsDraft !== null;
  const taken = new Set(overrides.map((row) => refKey(row.target)));
  const available = data.targets.filter((target) => !taken.has(refKey(target)));

  function openDialog(editing: PolicyOverrideView | null) {
    setDialog((current) => ({ editing, key: current.key + 1 }));
    dialogState.open();
  }

  function applyOverride(ref: PolicyRef, override: PolicyOverrideView | null) {
    setData((current) => ({ ...current, overrides: replaceOverride(current.overrides, ref, override) }));
  }

  function remove(row: PolicyOverrideView) {
    start(async () => {
      const result = await removePolicyOverrideAction({ scope: row.target.scope, id: row.target.id });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      applyOverride(result.ref, result.override);
      toast(t("overrides.saved", { mode: "removed" }), { variant: "success" });
    });
  }

  function savePii() {
    start(async () => {
      const result = await savePiiAction(pii, detector ?? undefined);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData((current) => ({ ...current, pii: result.pii, detector: result.detector }));
      setPii(null);
      setDetector(null);
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

  const overridesPanel = (
    <PolicyOverrides
      overrides={overrides}
      canManage={canManage}
      canAdd={available.length > 0}
      pending={pending}
      onAdd={() => openDialog(null)}
      onEdit={(row) => openDialog(row)}
      onRemove={remove}
    />
  );

  const piiPanel = (
    <div className="space-y-4 sm:space-y-5">
      <Card className="gap-4">
        <Card.Header className="flex-row flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <Card.Title>{t("pii.title")}</Card.Title>
            <Card.Description>{t("pii.hint")}</Card.Description>
          </div>
          <Chip size="sm" variant="soft" color={pii.enabled ? "success" : "warning"}>
            {t("sectionState", { state: pii.enabled ? pii.mode : "off" })}
          </Chip>
        </Card.Header>
        <Card.Content className="gap-4">
          <PiiPolicyFields value={pii} onChange={setPii} isDisabled={!canManage} />
          <Disclosure>
            <Disclosure.Heading>
              <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                {t("entitiesSummary", { count: pii.entities.length })}
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="pt-3">
                <PiiEntityPicker
                  value={pii.entities}
                  onChange={(entities) => setPii({ ...pii, entities })}
                  isDisabled={!canManage}
                  wide
                />
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
          {detector ? (
            <PiiModelFields
              value={detector}
              onChange={setDetector}
              models={models}
              configured={redactorConfigured}
              canManage={canManage}
            />
          ) : null}
        </Card.Content>
      </Card>
      {canEditPlatform ? (
        <FormActions
          label={t("save")}
          pending={pending}
          isDisabled={!piiDirty}
          onSave={savePii}
          extra={piiDirty ? <span className="text-sm text-warning">{tCommon("unsaved")}</span> : null}
        />
      ) : null}
    </div>
  );

  const contentPanel = (
    <div className="space-y-4 sm:space-y-5">
      <Card className="gap-4">
        <Card.Header>
          <Card.Title>{t("injection.title")}</Card.Title>
          <Card.Description>{t("injection.hint")}</Card.Description>
        </Card.Header>
        <Card.Content>
          <InjectionFields
            value={guardrails.injection}
            onChange={(injection) => setGuardrails({ ...guardrails, injection })}
            isDisabled={!canManage}
          />
        </Card.Content>
      </Card>
      <Card className="gap-4">
        <Card.Header>
          <Card.Title>{t("secrets.title")}</Card.Title>
          <Card.Description>{t("secrets.hint")}</Card.Description>
        </Card.Header>
        <Card.Content>
          <SecretsFields
            value={guardrails.secrets}
            onChange={(secrets) => setGuardrails({ ...guardrails, secrets })}
            isDisabled={!canManage}
          />
        </Card.Content>
      </Card>
      <Card className="gap-4">
        <Card.Header>
          <Card.Title>{t("rules.title")}</Card.Title>
          <Card.Description>{t("rules.hint")}</Card.Description>
        </Card.Header>
        <Card.Content>
          <GuardrailRules
            rules={guardrails.rules}
            onChange={(rules) => setGuardrails({ ...guardrails, rules })}
            isDisabled={!canManage}
          />
        </Card.Content>
      </Card>
      <Alert status="accent">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{t("content.streamHint")}</Alert.Description>
        </Alert.Content>
      </Alert>
      {canEditPlatform ? (
        <FormActions
          label={t("content.save")}
          pending={pending}
          isDisabled={!contentDirty || !guardrailsValid(guardrails)}
          onSave={saveContent}
          extra={contentDirty ? <span className="text-sm text-warning">{tCommon("unsaved")}</span> : null}
        />
      ) : null}
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader icon={Shield} title={t("title")} subtitle={platform ? t("subtitle") : t("companySubtitle")} />
      <PageTabs
        label={t("title")}
        tabs={[
          ...(platform
            ? [
                { id: "pii", label: t("tabs", { tab: "pii" }), panel: piiPanel },
                { id: "content", label: t("tabs", { tab: "content" }), panel: contentPanel },
              ]
            : []),
          { id: "overrides", label: t("tabs", { tab: "overrides" }), panel: overridesPanel },
          {
            id: "test",
            label: t("tabs", { tab: "test" }),
            panel: (
              <PolicyTester
                book={book}
                draft={{ pii: piiDraft ?? data.pii, guardrails }}
                isDraft={piiDirty || contentDirty}
              />
            ),
          },
        ]}
      />
      <OverrideDialog
        key={`override-${dialog.key}`}
        state={dialogState}
        book={book}
        editing={dialog.editing}
        available={available}
        onSaved={(result) => applyOverride(result.ref, result.override)}
      />
    </div>
  );
}
