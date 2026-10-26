"use client";

import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { POLICY_SCOPES } from "@/schemas/guardrails";
import type { PolicyRef, PolicyScope, PolicyTarget } from "@/types/guardrails";
import ChoiceSelect from "./choice-select";

export function firstRef(targets: readonly PolicyTarget[], scope?: PolicyScope): PolicyRef | null {
  const target = targets.find((row) => !scope || row.scope === scope);
  return target ? { scope: target.scope, id: target.id } : null;
}

export default function PolicyTargetPicker({
  targets,
  value,
  onChange,
  isDisabled,
}: {
  targets: readonly PolicyTarget[];
  value: PolicyRef | null;
  onChange: (ref: PolicyRef | null) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const scopes = POLICY_SCOPES.filter((scope) => targets.some((row) => row.scope === scope));
  const scope = value?.scope ?? scopes[0] ?? "org";
  const options = targets.filter((row) => row.scope === scope);

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
      <ChoiceSelect
        label={t("target.scope")}
        value={scope}
        options={scopes.map((id) => ({ id, label: t("scopeLabel", { scope: id }) }))}
        onChange={(next) => onChange(firstRef(targets, next))}
        isDisabled={isDisabled || scopes.length < 2}
      />
      <SearchSelect
        label={t("scopeLabel", { scope })}
        placeholder={tCommon("none")}
        items={options.map((row) => ({ id: row.id, label: row.alias, detail: row.path.join(" › ") || undefined }))}
        value={value?.scope === scope ? value.id : ""}
        onChange={(id) => onChange(id ? { scope, id } : null)}
        isDisabled={isDisabled || options.length === 0}
      />
    </div>
  );
}
