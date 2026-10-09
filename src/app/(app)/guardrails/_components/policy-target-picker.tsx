"use client";

import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import type { PolicyScope, PolicyTarget } from "@/types/guardrails";
import ChoiceSelect from "./choice-select";

const POLICY_SCOPES: readonly PolicyScope[] = ["org", "project", "key"];

export function inheritedPolicy<P>(
  target: PolicyTarget,
  overrides: (PolicyTarget & { policy: P })[],
  global: P,
): P {
  const find = (scope: PolicyScope, id: string) =>
    id ? overrides.find((row) => row.scope === scope && row.id === id)?.policy : undefined;
  const project = target.scope === "key" ? find("project", target.projectId) : undefined;
  const org = target.scope === "org" ? undefined : find("org", target.orgId);
  return project ?? org ?? global;
}

export default function PolicyTargetPicker({
  targets,
  scope,
  targetId,
  onScopeChange,
  onTargetChange,
  isDisabled,
}: {
  targets: PolicyTarget[];
  scope: PolicyScope;
  targetId: string;
  onScopeChange: (scope: PolicyScope) => void;
  onTargetChange: (id: string) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const options = targets.filter((row) => row.scope === scope);
  const names = new Map(targets.filter((row) => row.scope !== "key").map((row) => [`${row.scope}:${row.id}`, row.alias]));

  function detail(row: PolicyTarget): string | undefined {
    if (row.scope === "org") return undefined;
    const company = names.get(`org:${row.orgId}`);
    const project = row.scope === "key" ? names.get(`project:${row.projectId}`) : undefined;
    return [project, company].filter(Boolean).join(" · ") || undefined;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ChoiceSelect
        label={t("scope")}
        value={scope}
        options={POLICY_SCOPES.map((id) => ({ id, label: t("scopeLabel", { scope: id }) }))}
        onChange={onScopeChange}
        isDisabled={isDisabled}
      />
      <SearchSelect
        label={t("scopeLabel", { scope })}
        placeholder={tCommon("none")}
        items={options.map((row) => ({ id: row.id, label: row.alias, detail: detail(row) }))}
        value={targetId}
        onChange={onTargetChange}
        isDisabled={isDisabled || options.length === 0}
      />
    </div>
  );
}
