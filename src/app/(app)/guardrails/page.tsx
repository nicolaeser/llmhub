"use client";

import { useState, useTransition } from "react";
import { toast, useOverlayState } from "@heroui/react";
import { Shield } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import { useErrorToast } from "@/components/console/use-error-toast";
import { refKey } from "@/lib/gateway/safety/policy-layers";
import { useActionData } from "@/lib/hooks/use-action-data";
import { setSearchParams } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import type { GuardrailPolicy, PolicyOverrideView, PolicyRef } from "@/types/guardrails";
import { useConsoleScope } from "../_components/console-scope";
import { loadGuardrailsAction, removePolicyOverrideAction } from "./_action";
import CheckDialog, { type CheckSection } from "./_components/check-dialog";
import OverrideDialog from "./_components/override-dialog";
import PiiDialog from "./_components/pii-dialog";
import PolicyOverrides from "./_components/policy-overrides";
import PolicyOverview from "./_components/policy-overview";
import PolicyTester from "./_components/policy-tester";
import { replaceOverride, sortOverrides, type PolicyBook } from "./_components/policy-view";
import RulesTab from "./_components/rules-tab";

type OverrideTarget = { editing: PolicyOverrideView | null; key: number };
type SectionTarget = { section: CheckSection | "pii"; key: number };

export default function GuardrailsPage() {
  const t = useTranslations("Guardrails");
  const showError = useErrorToast();
  const [override, setOverride] = useState<OverrideTarget>({ editing: null, key: 0 });
  const [section, setSection] = useState<SectionTarget>({ section: "pii", key: 0 });
  const [pending, start] = useTransition();
  const overrideState = useOverlayState();
  const piiState = useOverlayState();
  const checkState = useOverlayState();
  const page = useActionData(loadGuardrailsAction);
  const { data, setData } = page;
  const { kind } = useConsoleScope();

  if (!data) {
    return (
      <PageStatus
        icon={Shield}
        title={t("title")}
        subtitle={kind === "company" ? t("companySubtitle") : t("subtitle")}
        state={page}
        tabs
        layout={kind === "company" ? "table" : "cards"}
      />
    );
  }

  const { canManage, platform } = data;
  const canEditPlatform = canManage && platform;
  const overrides = sortOverrides(data.overrides);
  const book: PolicyBook = {
    platform: { pii: data.pii, guardrails: data.guardrails },
    overrides,
    targets: data.targets,
  };
  const taken = new Set(overrides.map((row) => refKey(row.target)));
  const available = data.targets.filter((target) => !taken.has(refKey(target)));

  function openOverride(editing: PolicyOverrideView | null) {
    setOverride((current) => ({ editing, key: current.key + 1 }));
    overrideState.open();
  }

  function openSection(next: CheckSection | "pii") {
    setSection((current) => ({ section: next, key: current.key + 1 }));
    if (next === "pii") piiState.open();
    else checkState.open();
  }

  function applyOverride(ref: PolicyRef, next: PolicyOverrideView | null) {
    setData((current) => ({ ...current, overrides: replaceOverride(current.overrides, ref, next) }));
  }

  function applyGuardrails(guardrails: GuardrailPolicy) {
    setData((current) => ({ ...current, guardrails }));
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

  const overridesPanel = (
    <PolicyOverrides
      book={book}
      canManage={canManage}
      canAdd={available.length > 0}
      pending={pending}
      onAdd={() => openOverride(null)}
      onEdit={openOverride}
      onRemove={remove}
    />
  );

  return (
    <div className="space-y-5">
      <PageHeader icon={Shield} title={t("title")} subtitle={platform ? t("subtitle") : t("companySubtitle")} />
      <PageTabs
        label={t("title")}
        tabs={[
          ...(platform
            ? [
                {
                  id: "policy",
                  label: t("tabs", { tab: "policy" }),
                  panel: (
                    <PolicyOverview
                      book={book}
                      canEdit={canEditPlatform}
                      onEdit={openSection}
                      onOpenTab={(tab) => setSearchParams({ tab })}
                    />
                  ),
                },
                {
                  id: "rules",
                  label: t("tabs", { tab: "rules" }),
                  panel: <RulesTab policy={data.guardrails} canManage={canEditPlatform} onSaved={applyGuardrails} />,
                },
              ]
            : []),
          { id: "overrides", label: t("tabs", { tab: "overrides" }), panel: overridesPanel },
          { id: "test", label: t("tabs", { tab: "test" }), panel: <PolicyTester book={book} /> },
        ]}
      />
      {canEditPlatform ? (
        <>
          <PiiDialog
            key={`pii-${section.key}`}
            state={piiState}
            policy={data.pii}
            detector={data.detector}
            models={data.models}
            redactorConfigured={data.redactorConfigured}
            onSaved={(result) => setData((current) => ({ ...current, pii: result.pii, detector: result.detector }))}
          />
          {section.section === "pii" ? null : (
            <CheckDialog
              key={`check-${section.key}`}
              state={checkState}
              section={section.section}
              policy={data.guardrails}
              onSaved={applyGuardrails}
            />
          )}
        </>
      ) : null}
      {canManage ? (
        <OverrideDialog
          key={`override-${override.key}`}
          state={overrideState}
          book={book}
          editing={override.editing}
          available={available}
          onSaved={(result) => applyOverride(result.ref, result.override)}
        />
      ) : null}
    </div>
  );
}
