import type {
  DataRegion,
  ModelPolicy,
  PolicyGroup,
  ProviderPolicy,
  TemplateRules,
} from "@/types/model-templates";

export const DATA_REGIONS = ["eu", "us", "global"] as const satisfies readonly DataRegion[];

export function isDataRegion(value: unknown): value is DataRegion {
  return DATA_REGIONS.includes(value as DataRegion);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

export function templateRulesOf(row: {
  models: unknown;
  patterns: unknown;
  providerIds: unknown;
  regions: unknown;
  zdrOnly: boolean;
  noTrainingOnly: boolean;
  maxRetentionDays: number | null;
}): TemplateRules {
  return {
    models: strings(row.models),
    patterns: strings(row.patterns),
    providerIds: strings(row.providerIds),
    regions: strings(row.regions).filter(isDataRegion),
    zdrOnly: row.zdrOnly,
    noTrainingOnly: row.noTrainingOnly,
    maxRetentionDays: row.maxRetentionDays,
  };
}

export function hasRules(rules: TemplateRules): boolean {
  return (
    rules.patterns.length > 0 ||
    rules.providerIds.length > 0 ||
    rules.regions.length > 0 ||
    rules.zdrOnly ||
    rules.noTrainingOnly ||
    rules.maxRetentionDays !== null
  );
}

export function patternMatches(pattern: string, alias: string): boolean {
  const p = pattern.trim().toLowerCase();
  const s = alias.toLowerCase();
  if (!p) return false;
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = si;
    } else if (pi < p.length && p[pi] === s[si]) {
      pi++;
      si++;
    } else if (star >= 0) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

function reachable(alias: string, byAlias: Map<string, PolicyGroup>): PolicyGroup[] {
  const seen = new Set<string>();
  const queue = [alias];
  const out: PolicyGroup[] = [];
  while (queue.length) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    if (next === "auto") {
      queue.push(...byAlias.keys());
      continue;
    }
    const group = byAlias.get(next);
    if (!group) continue;
    out.push(group);
    queue.push(...group.fallbackGroups, group.overflowGroup);
  }
  return out;
}

export function modelPolicies(groups: PolicyGroup[], providers: ProviderPolicy[]): ModelPolicy[] {
  const byAlias = new Map(groups.map((group) => [group.alias, group]));
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return groups.map((group) => {
    const linked = reachable(group.alias, byAlias)
      .flatMap((node) => node.providerIds)
      .map((id) => (id ? (byId.get(id) ?? null) : null));
    const known = linked.filter((provider): provider is ProviderPolicy => provider !== null);
    const custom = known.length !== linked.length;
    const complete = linked.length > 0 && !custom;
    let retentionDays: number | null = complete ? 0 : null;
    for (const provider of known) {
      const days = provider.zdr ? 0 : provider.retentionDays;
      retentionDays = days === null || retentionDays === null ? null : Math.max(retentionDays, days);
    }
    return {
      alias: group.alias,
      providerIds: [...new Set(known.map((provider) => provider.id))].sort(),
      custom,
      zdr: complete && known.every((provider) => provider.zdr),
      noTraining: complete && known.every((provider) => provider.zdr || provider.noTraining),
      retentionDays,
      regions: [...new Set(linked.map((provider) => provider?.region ?? ""))].sort(),
    };
  });
}

export function templateMatches(rules: TemplateRules, policy: ModelPolicy): boolean {
  if (rules.models.includes(policy.alias)) return true;
  if (!hasRules(rules)) return false;
  if (rules.patterns.length && !rules.patterns.some((pattern) => patternMatches(pattern, policy.alias))) {
    return false;
  }
  if (
    rules.providerIds.length &&
    (policy.custom ||
      policy.providerIds.length === 0 ||
      !policy.providerIds.every((id) => rules.providerIds.includes(id)))
  ) {
    return false;
  }
  if (rules.zdrOnly && !policy.zdr) return false;
  if (rules.noTrainingOnly && !policy.noTraining) return false;
  if (
    rules.maxRetentionDays !== null &&
    (policy.retentionDays === null || policy.retentionDays > rules.maxRetentionDays)
  ) {
    return false;
  }
  if (
    rules.regions.length &&
    (policy.regions.length === 0 || !policy.regions.every((region) => rules.regions.includes(region)))
  ) {
    return false;
  }
  return true;
}

export function templateModels(rules: TemplateRules, policies: ModelPolicy[]): string[] {
  const matched = policies.filter((policy) => templateMatches(rules, policy)).map((policy) => policy.alias);
  return [...new Set([...matched, ...rules.models])];
}

export function resolveTemplates(templates: TemplateRules[], policies: ModelPolicy[]): string[] {
  return [...new Set(templates.flatMap((rules) => templateModels(rules, policies)))];
}
