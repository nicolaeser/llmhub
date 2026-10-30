"use client";

import { useState, useTransition } from "react";
import { Separator, toast, type useOverlayState } from "@heroui/react";
import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import StepDialog, { type DialogStep } from "@/components/console/step-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import {
  draftAccessValid,
  draftBasicsValid,
  draftNetworkValid,
  draftOfKey,
  draftScheduleValid,
  keyFieldsOf,
  newKeyDraft,
} from "@/lib/keys/draft";
import type { ActionFail } from "@/types/actions";
import type {
  IssuedKey,
  KeyBindingKind,
  KeyCreateInput,
  KeyDraft,
  KeyOptions,
  KeyPreset,
  KeyUpdateInput,
  VirtualKeyView,
} from "@/types/keys";
import type { BudgetInput, BudgetResult } from "@/types/structure";
import AccessWindowFields from "./access-window-fields";
import {
  BindingFields,
  BudgetFields,
  EndpointsField,
  ExpiryField,
  IpAllowlistField,
  KeyNameField,
  KeySwitchField,
  ModelAccessFields,
  RateLimitFields,
} from "./key-fields";

function initialKind(preset: KeyPreset | null, options: KeyOptions, canBind: boolean): KeyBindingKind {
  if (!canBind) return "internal";
  if (preset) return preset.kind;
  return options.projects.length || options.members.length ? "project" : "internal";
}

export default function KeyDialog({
  state,
  editing,
  preset,
  options,
  canBind,
  onCreate,
  onUpdate,
  onBudget,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: VirtualKeyView | null;
  preset: KeyPreset | null;
  options: KeyOptions;
  canBind: boolean;
  onCreate: (input: KeyCreateInput) => Promise<{ key: IssuedKey } | ActionFail>;
  onUpdate: (input: KeyUpdateInput) => Promise<{ key: VirtualKeyView } | ActionFail>;
  onBudget?: (input: BudgetInput) => Promise<BudgetResult | ActionFail>;
  onSaved: (key: VirtualKeyView, secret: string | null) => void;
}) {
  const t = useTranslations("Keys");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<KeyDraft>(() =>
    editing ? draftOfKey(editing) : newKeyDraft(initialKind(preset, options, canBind), preset),
  );
  const [pending, start] = useTransition();
  const change = (patch: Partial<KeyDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const mode = editing ? "edit" : "create";

  function save(close: () => void) {
    start(async () => {
      const fields = keyFieldsOf(draft);
      if (editing) {
        const result = await onUpdate({ ...fields, id: editing.token_id, blocked: draft.blocked });
        if (isActionFail(result)) {
          showError(result.error);
          return;
        }
        onSaved(result.key, null);
        toast(t("toasts.saved", { mode: "updated" }), { variant: "success" });
        close();
        return;
      }
      const result = await onCreate({ ...fields, days: draft.days });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      const { key: secret, ...created } = result.key;
      let row: VirtualKeyView = created;
      if (onBudget && draft.budget > 0) {
        const budget = await onBudget({
          kind: "key",
          id: created.token_id,
          maxBudget: draft.budget,
          budgetDuration: draft.budgetPeriod,
        });
        if (isActionFail(budget)) showError(budget.error);
        else
          row = {
            ...created,
            max_budget: budget.budget.maxBudget,
            spend: budget.budget.spend,
            budget_duration: budget.budget.budgetDuration,
          };
      }
      onSaved(row, secret);
      toast(t("toasts.saved", { mode: "created" }), { variant: "success" });
      close();
    });
  }

  const steps: DialogStep[] = [
    {
      id: "basics",
      title: t("wizard.step", { step: "basics" }),
      description: t("wizard.stepHint", { step: "basics" }),
      isValid: draftBasicsValid(draft),
      content: (
        <>
          <KeyNameField value={draft.alias} onChange={(alias) => change({ alias })} isDisabled={pending} />
          <BindingFields draft={draft} options={options} canBind={canBind} isDisabled={pending} onChange={change} />
        </>
      ),
    },
    {
      id: "models",
      title: t("wizard.step", { step: "models" }),
      description: t("wizard.stepHint", { step: "models" }),
      isValid: draftAccessValid(draft),
      content: <ModelAccessFields draft={draft} options={options} isDisabled={pending} onChange={change} />,
    },
    {
      id: "limits",
      title: t("wizard.step", { step: "limits" }),
      description: t("wizard.stepHint", { step: "limits" }),
      optional: true,
      content: (
        <>
          {onBudget && !editing ? (
            <>
              <BudgetFields draft={draft} isDisabled={pending} onChange={change} />
              <Separator />
            </>
          ) : null}
          <RateLimitFields draft={draft} isDisabled={pending} onChange={change} />
          {editing ? null : (
            <>
              <Separator />
              <ExpiryField days={draft.days} isDisabled={pending} onChange={(days) => change({ days })} />
            </>
          )}
        </>
      ),
    },
    {
      id: "restrictions",
      title: t("wizard.step", { step: "restrictions" }),
      description: t("wizard.stepHint", { step: "restrictions" }),
      optional: true,
      isValid: draftNetworkValid(draft) && draftScheduleValid(draft),
      content: (
        <>
          <IpAllowlistField value={draft.ips} isDisabled={pending} onChange={(ips) => change({ ips })} />
          <EndpointsField draft={draft} isDisabled={pending} onChange={change} />
          <Separator />
          <AccessWindowFields
            windows={draft.windows}
            timeZone={draft.timeZone}
            isDisabled={pending}
            onWindowsChange={(windows) => change({ windows })}
            onTimeZoneChange={(timeZone) => change({ timeZone })}
          />
          <Separator />
          <KeySwitchField
            label={t("fields.logContent")}
            description={t("fields.logContentHint")}
            isSelected={draft.logContent}
            isDisabled={pending}
            onChange={(logContent) => change({ logContent })}
          />
          {editing ? (
            <KeySwitchField
              label={t("fields.blocked")}
              description={t("fields.blockedHint")}
              isSelected={draft.blocked}
              isDisabled={pending}
              onChange={(blocked) => change({ blocked })}
            />
          ) : null}
        </>
      ),
    },
  ];

  return (
    <StepDialog
      state={state}
      title={t("dialogTitle", { mode })}
      description={t("wizard.description", { mode })}
      steps={steps}
      submitLabel={t("dialogSubmit", { mode })}
      submitIcon={editing ? undefined : <KeyRound size={16} aria-hidden />}
      pending={pending}
      onSubmit={save}
    />
  );
}
