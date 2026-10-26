"use client";

import { Fragment, useState, useTransition } from "react";
import { Alert, Chip, Disclosure, Label, Separator, Switch, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import IconTile from "@/components/console/icon-tile";
import { useErrorToast } from "@/components/console/use-error-toast";
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
import GuardrailRules from "./guardrail-rules";
import InjectionFields from "./injection-fields";
import PiiEntityPicker from "./pii-entity-picker";
import PiiPolicyFields from "./pii-policy-fields";
import { SECTION_ICONS, SectionChip, SectionDetail, useSourceLabel } from "@/components/guardrails/policy-labels";
import PolicyTargetPicker, { firstRef } from "./policy-target-picker";
import { findTarget, inheritedFor, type PolicyBook } from "./policy-view";
import SecretsFields from "./secrets-fields";

export default function OverrideDialog({
  state,
  book,
  editing,
  initialRef,
  available,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  book: PolicyBook;
  editing: PolicyOverrideView | null;
  initialRef: PolicyRef | null;
  available: PolicyTarget[];
  onSaved: (result: { ref: PolicyRef; override: PolicyOverrideView | null }) => void;
}) {
  const t = useTranslations("Guardrails");
  const showError = useErrorToast();
  const [ref, setRef] = useState<PolicyRef | null>(() => {
    const start = editing?.target ?? initialRef ?? firstRef(available);
    return start ? { scope: start.scope, id: start.id } : null;
  });
  const [layer, setLayer] = useState<PolicyLayer>(() =>
    editing
      ? { pii: editing.pii, injection: editing.injection, secrets: editing.secrets, rules: editing.rules }
      : INHERIT_ALL,
  );
  const [pending, start] = useTransition();
  const sourceLabel = useSourceLabel((source) => findTarget(book, source)?.alias);
  const target = editing?.target ?? findTarget(book, ref);
  const inherited = target ? inheritedFor(book, target) : effectivePolicies(book.platform, []);
  const inheritedLayer = fullLayer(inherited);
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

  function fields(section: PolicySection) {
    if (section === "pii" && layer.pii) {
      const pii = layer.pii;
      return (
        <div className="space-y-4">
          <PiiPolicyFields
            value={pii}
            onChange={(next) => setLayer((cur) => ({ ...cur, pii: next }))}
            isDisabled={pending}
          />
          <Disclosure>
            <Disclosure.Heading>
              <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                {t("dialog.entities", { count: pii.entities.length })}
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="pt-3">
                <PiiEntityPicker
                  value={pii.entities}
                  onChange={(entities) =>
                    setLayer((cur) => ({ ...cur, pii: cur.pii ? { ...cur.pii, entities } : cur.pii }))
                  }
                  isDisabled={pending}
                />
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        </div>
      );
    }
    if (section === "injection" && layer.injection) {
      return (
        <InjectionFields
          value={layer.injection}
          onChange={(next) => setLayer((cur) => ({ ...cur, injection: next }))}
          isDisabled={pending}
        />
      );
    }
    if (section === "secrets" && layer.secrets) {
      return (
        <SecretsFields
          value={layer.secrets}
          onChange={(next) => setLayer((cur) => ({ ...cur, secrets: next }))}
          isDisabled={pending}
        />
      );
    }
    if (section === "rules" && layer.rules) {
      return (
        <GuardrailRules
          rules={layer.rules}
          onChange={(rules) => setLayer((cur) => ({ ...cur, rules }))}
          isDisabled={pending}
        />
      );
    }
    const summary = sectionSummaries(inheritedLayer).find((row) => row.section === section);
    return summary ? (
      <div className="flex flex-wrap items-center gap-2">
        <SectionChip summary={summary} />
        <SectionDetail summary={summary} />
      </div>
    ) : null;
  }

  return (
    <FormDialog
      state={state}
      size="xl"
      title={t("dialog.title", { mode: editing ? "edit" : "create" })}
      description={t("dialog.hint")}
      submitLabel={clearing ? t("overrides.remove") : t("dialog.save")}
      submitVariant={clearing ? "danger" : "primary"}
      pending={pending}
      isSubmitDisabled={!ref || !rulesValid || (!editing && isInheritAll(layer))}
      onSubmit={save}
    >
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="soft">
            {t("scopeLabel", { scope: editing.target.scope })}
          </Chip>
          <span className="text-sm font-medium break-words">{editing.target.alias}</span>
          {editing.target.path.length ? (
            <span className="text-xs break-words text-muted">{editing.target.path.join(" › ")}</span>
          ) : null}
        </div>
      ) : (
        <PolicyTargetPicker targets={available} value={ref} onChange={pickTarget} isDisabled={pending} />
      )}
      {POLICY_SECTIONS.map((section) => {
        const custom = layer[section] !== null;
        const label = t("section", { section });
        return (
          <Fragment key={section}>
            <Separator />
            <section className="space-y-4" aria-label={label}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <IconTile icon={SECTION_ICONS[section]} size="sm" tone={custom ? "accent" : "neutral"} />
                  <div className="min-w-0 space-y-0.5">
                    <h3 className="text-sm font-semibold">{label}</h3>
                    <p className="text-xs text-muted">
                      {custom
                        ? t("dialog.custom", { section })
                        : t("dialog.inherited", { source: sourceLabel(inherited.sources[section]) })}
                    </p>
                  </div>
                </div>
                <Switch
                  isSelected={custom}
                  onChange={(next) => toggle(section, next)}
                  isDisabled={pending || !target}
                  aria-label={t("dialog.setHereFor", { section })}
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <Label>{t("dialog.setHere")}</Label>
                  </Switch.Content>
                </Switch>
              </div>
              {fields(section)}
            </section>
          </Fragment>
        );
      })}
      {clearing ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("dialog.clearing")}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </FormDialog>
  );
}
