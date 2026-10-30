"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Alert, Card, Chip, Description, Disclosure, Label, Switch, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import StepDialog, { type DialogStep } from "@/components/console/step-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { SectionChip, SectionDetail, useSectionText, useSourceLabel } from "@/components/guardrails/policy-labels";
import { guardrailsValid } from "@/lib/gateway/safety/guardrails";
import {
  effectivePolicies,
  fullLayer,
  INHERIT_ALL,
  isInheritAll,
  sectionSummaries,
} from "@/lib/gateway/safety/policy-layers";
import { isActionFail } from "@/lib/http/action-result";
import { POLICY_SECTIONS } from "@/schemas/guardrails";
import type { PolicyLayer, PolicyOverrideView, PolicyRef, PolicySection, PolicyTarget } from "@/types/guardrails";
import { savePolicyOverrideAction } from "../_action";
import InjectionFields from "./injection-fields";
import OverrideRules from "./override-rules";
import PiiEntityPicker from "./pii-entity-picker";
import { PiiBehaviorFields, PiiDetectionFields } from "./pii-policy-fields";
import PolicyTargetPicker, { firstRef } from "./policy-target-picker";
import { findTarget, inheritedFor, type PolicyBook } from "./policy-view";
import SecretsFields from "./secrets-fields";

function MoreSettings({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Disclosure>
      <Disclosure.Heading>
        <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
          {title}
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="pt-3">{children}</Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

export default function OverrideDialog({
  state,
  book,
  editing,
  available,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  book: PolicyBook;
  editing: PolicyOverrideView | null;
  available: PolicyTarget[];
  onSaved: (result: { ref: PolicyRef; override: PolicyOverrideView | null }) => void;
}) {
  const t = useTranslations("Guardrails");
  const showError = useErrorToast();
  const [ref, setRef] = useState<PolicyRef | null>(() => {
    if (editing) return { scope: editing.target.scope, id: editing.target.id };
    return firstRef(available);
  });
  const [layer, setLayer] = useState<PolicyLayer>(() =>
    editing
      ? { pii: editing.pii, injection: editing.injection, secrets: editing.secrets, rules: editing.rules }
      : INHERIT_ALL,
  );
  const [pending, start] = useTransition();
  const sourceLabel = useSourceLabel((source) => findTarget(book, source)?.alias);
  const sectionText = useSectionText();
  const target = editing?.target ?? findTarget(book, ref);
  const inherited = target ? inheritedFor(book, target) : effectivePolicies(book.platform, []);
  const inheritedLayer = fullLayer(inherited);
  const inheritedSummaries = sectionSummaries(inheritedLayer);
  const ownSummaries = sectionSummaries(layer);
  const clearing = Boolean(editing) && isInheritAll(layer);
  const rulesValid = !layer.rules || guardrailsValid({ ...book.platform.guardrails, rules: layer.rules });

  function toggle(section: PolicySection, custom: boolean) {
    setLayer((current) => ({ ...current, [section]: custom ? structuredClone(inheritedLayer[section]) : null }));
  }

  function pickTarget(next: PolicyRef | null) {
    setRef(next);
    setLayer(INHERIT_ALL);
  }

  function save(close: () => void) {
    if (!ref) return;
    start(async () => {
      const result = await savePolicyOverrideAction({ ...ref, ...layer });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result);
      toast(t("overrides.saved", { mode: result.override ? "saved" : "removed" }), { variant: "success" });
      close();
    });
  }

  function inheritedLine(section: PolicySection) {
    const summary = inheritedSummaries.find((row) => row.section === section);
    return t("dialog.inherited", {
      source: sourceLabel(inherited.sources[section]),
      summary: summary ? sectionText(summary) : "",
    });
  }

  function fields(section: PolicySection) {
    if (section === "pii" && layer.pii) {
      const pii = layer.pii;
      const change = (next: typeof pii) => setLayer((current) => ({ ...current, pii: next }));
      return (
        <div className="space-y-4">
          <PiiBehaviorFields value={pii} onChange={change} isDisabled={pending} />
          <MoreSettings title={t("entitiesSummary", { count: pii.entities.length })}>
            <PiiEntityPicker
              value={pii.entities}
              onChange={(entities) => change({ ...pii, entities })}
              isDisabled={pending}
            />
          </MoreSettings>
          <MoreSettings title={t("detectionSummary", { detector: pii.detector })}>
            <PiiDetectionFields value={pii} onChange={change} isDisabled={pending} />
          </MoreSettings>
        </div>
      );
    }
    if (section === "injection" && layer.injection) {
      return (
        <InjectionFields
          value={layer.injection}
          onChange={(next) => setLayer((current) => ({ ...current, injection: next }))}
          isDisabled={pending}
        />
      );
    }
    if (section === "secrets" && layer.secrets) {
      return (
        <SecretsFields
          value={layer.secrets}
          onChange={(next) => setLayer((current) => ({ ...current, secrets: next }))}
          isDisabled={pending}
        />
      );
    }
    if (section === "rules" && layer.rules) {
      return (
        <OverrideRules
          rules={layer.rules}
          onChange={(rules) => setLayer((current) => ({ ...current, rules }))}
          isDisabled={pending}
        />
      );
    }
    return null;
  }

  function sectionStep(section: PolicySection): DialogStep {
    const custom = layer[section] !== null;
    return {
      id: section,
      title: t("dialog.step", { step: section }),
      optional: true,
      isValid: section === "rules" ? rulesValid : undefined,
      content: (
        <div className="space-y-5">
          <Card variant="secondary" className="gap-3">
            <Switch
              isSelected={custom}
              onChange={(next) => toggle(section, next)}
              isDisabled={pending || !target}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Label>{t("dialog.setHereFor", { section })}</Label>
              </Switch.Content>
              <Description>{custom ? t("dialog.custom", { section }) : inheritedLine(section)}</Description>
            </Switch>
          </Card>
          {fields(section)}
        </div>
      ),
    };
  }

  const overview = (
    <dl className="grid gap-3 sm:grid-cols-2">
      {POLICY_SECTIONS.map((section) => {
        const own = ownSummaries.find((row) => row.section === section);
        const from = inheritedSummaries.find((row) => row.section === section);
        const shown = own ?? from;
        return (
          <Card key={section} variant="secondary" className="gap-1.5">
            <dt className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-foreground">
              {t("section", { section })}
              <Chip size="sm" variant="soft" color={own ? "accent" : undefined}>
                {t("dialog.origin", { own: own ? "true" : "false" })}
              </Chip>
            </dt>
            <dd className="flex flex-wrap items-center gap-2">
              {shown ? (
                <>
                  <SectionChip summary={shown} />
                  <SectionDetail summary={shown} />
                </>
              ) : null}
            </dd>
            {own ? null : (
              <dd className="text-xs break-words text-muted">
                {t("dialog.from", { source: sourceLabel(inherited.sources[section]) })}
              </dd>
            )}
          </Card>
        );
      })}
    </dl>
  );

  return (
    <StepDialog
      state={state}
      size="xl"
      title={editing ? t("dialog.title", { mode: "edit" }) : t("dialog.title", { mode: "create" })}
      description={t("dialog.hint")}
      submitLabel={clearing ? t("overrides.remove") : t("dialog.save")}
      pending={pending}
      isSubmitDisabled={!ref || !rulesValid || (!editing && isInheritAll(layer))}
      onSubmit={save}
      steps={[
        {
          id: "target",
          title: t("dialog.step", { step: "target" }),
          description: editing ? t("dialog.targetEditHint") : t("dialog.targetHint"),
          isValid: ref !== null,
          content: (
            <div className="space-y-5">
              {editing ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Chip size="sm" variant="soft">
                    {t("scopeLabel", { scope: editing.target.scope })}
                  </Chip>
                  <span className="text-sm font-medium break-words text-foreground">{editing.target.alias}</span>
                  {editing.target.path.length ? (
                    <span className="text-xs break-words text-muted">{editing.target.path.join(" › ")}</span>
                  ) : null}
                </div>
              ) : (
                <PolicyTargetPicker targets={available} value={ref} onChange={pickTarget} isDisabled={pending} />
              )}
              {target ? overview : null}
              {clearing ? (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{t("dialog.clearing")}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
            </div>
          ),
        },
        ...POLICY_SECTIONS.map(sectionStep),
      ]}
    />
  );
}
