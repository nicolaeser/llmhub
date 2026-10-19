"use client";

import { useEffect, useState } from "react";
import { Spinner, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useTranslations } from "next-intl";
import { loadAssignmentOptionsAction } from "../_action";
import MultiPicker from "@/components/console/multi-picker";
import { ASSIGNMENT_SCOPES } from "@/lib/gateway/routing/account-access";
import { isActionFail } from "@/lib/http/action-result";
import type { AccessMode, AssignmentOptions, AssignmentScope, AssignmentTarget } from "@/types/providers";
import { useErrorToast } from "@/components/console/use-error-toast";

const MODES: AccessMode[] = ["open", "limited"];

const NO_OPTIONS: AssignmentOptions = { org: [], team: [], project: [], member: [], key: [] };

export function pickedFrom(targets: AssignmentTarget[]): Record<AssignmentScope, string[]> {
  const picked: Record<AssignmentScope, string[]> = { org: [], team: [], project: [], member: [], key: [] };
  for (const target of targets) picked[target.scope].push(target.id);
  return picked;
}

export function pickedTargets(picked: Record<AssignmentScope, string[]>) {
  return ASSIGNMENT_SCOPES.flatMap((scope) => picked[scope].map((id) => ({ scope, id })));
}

export function useAssignmentOptions(isOpen: boolean): AssignmentOptions | null {
  const showError = useErrorToast();
  const [options, setOptions] = useState<AssignmentOptions | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    loadAssignmentOptionsAction().then((result) => {
      if (!active) return;
      if (isActionFail(result)) {
        showError(result.error);
        setOptions(NO_OPTIONS);
        return;
      }
      setOptions(result.options);
    });
    return () => {
      active = false;
    };
  }, [isOpen, showError]);

  return options;
}

export default function AccessFields({
  mode,
  onModeChange,
  picked,
  onPickedChange,
  options,
  known,
  isDisabled,
}: {
  mode: AccessMode;
  onModeChange: (mode: AccessMode) => void;
  picked: Record<AssignmentScope, string[]>;
  onPickedChange: (picked: Record<AssignmentScope, string[]>) => void;
  options: AssignmentOptions | null;
  known: AssignmentTarget[];
  isDisabled: boolean;
}) {
  const t = useTranslations("Subscriptions.access");
  const tCommon = useTranslations("Common");
  const total = ASSIGNMENT_SCOPES.reduce((sum, scope) => sum + picked[scope].length, 0);

  function itemsFor(scope: AssignmentScope) {
    const listed = options?.[scope] ?? [];
    const labels = known
      .filter((target) => target.scope === scope && !listed.some((item) => item.id === target.id))
      .map((target) => ({ id: target.id, label: target.label }));
    return [...listed, ...labels];
  }

  return (
    <>
      <ToggleButtonGroup
        fullWidth
        selectionMode="single"
        disallowEmptySelection
        aria-label={t("mode")}
        selectedKeys={[mode]}
        onSelectionChange={(keys) => {
          const next = MODES.find((item) => item === [...keys][0]);
          if (next) onModeChange(next);
        }}
        isDisabled={isDisabled}
      >
        {MODES.map((item, index) => (
          <ToggleButton key={item} id={item}>
            {index > 0 ? <ToggleButtonGroup.Separator /> : null}
            {t("modes", { mode: item })}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {mode === "limited" ? (
        options === null ? (
          <output
            aria-live="polite"
            aria-label={tCommon("loading")}
            className="flex justify-center py-6 text-accent"
          >
            <Spinner color="current" />
          </output>
        ) : (
          <div className="space-y-4">
            {ASSIGNMENT_SCOPES.map((scope) => (
              <MultiPicker
                key={scope}
                label={t("scope", { scope })}
                placeholder={t("scope", { scope })}
                searchLabel={t("search")}
                emptyLabel={t("empty")}
                items={itemsFor(scope)}
                selected={picked[scope]}
                onChange={(ids) => onPickedChange({ ...picked, [scope]: ids })}
                isDisabled={isDisabled}
              />
            ))}
            {total === 0 ? <p className="text-sm text-warning">{t("nothing")}</p> : null}
          </div>
        )
      ) : null}
    </>
  );
}
