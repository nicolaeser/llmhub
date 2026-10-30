import { hasRules, templateModels } from "@/lib/gateway/access/model-policy";
import type { ModelPolicy, TemplateProviderOption, TemplateRules } from "@/types/model-templates";

export type PresetCondition =
  | { kind: "zdr" }
  | { kind: "noTraining" }
  | { kind: "retention"; days: number }
  | { kind: "regions"; regions: string[] }
  | { kind: "patterns"; patterns: string[] }
  | { kind: "picked"; count: number };

export type PresetMode = "empty" | "picked" | "rules";

export type PresetSummary = {
  mode: PresetMode;
  matches: string[];
  providers: string[];
  removed: number;
  conditions: PresetCondition[];
};

export function presetSummary(
  rules: TemplateRules,
  policies: ModelPolicy[],
  providers: readonly Pick<TemplateProviderOption, "id" | "name">[],
): PresetSummary {
  const ruled = hasRules(rules);
  const mode: PresetMode = ruled ? "rules" : rules.models.length ? "picked" : "empty";
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  const known = rules.providerIds.filter((id) => names.has(id));
  const conditions: (PresetCondition | null)[] = [
    rules.zdrOnly ? { kind: "zdr" } : null,
    rules.noTrainingOnly ? { kind: "noTraining" } : null,
    rules.maxRetentionDays !== null ? { kind: "retention", days: rules.maxRetentionDays } : null,
    rules.regions.length ? { kind: "regions", regions: [...rules.regions] } : null,
    rules.patterns.length ? { kind: "patterns", patterns: [...rules.patterns] } : null,
    ruled && rules.models.length ? { kind: "picked", count: rules.models.length } : null,
  ];
  return {
    mode,
    matches: mode === "empty" ? [] : templateModels(rules, policies),
    providers: known.map((id) => names.get(id) ?? id),
    removed: rules.providerIds.length - known.length,
    conditions: conditions.filter((condition): condition is PresetCondition => condition !== null),
  };
}

export function presetMatches(
  preset: { name: string; description: string },
  summary: Pick<PresetSummary, "providers" | "matches">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [preset.name, preset.description, ...summary.providers, ...summary.matches].some((value) =>
    value.toLowerCase().includes(needle),
  );
}
