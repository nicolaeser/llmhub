import type {
  DataRegion,
  DeploymentRule,
  ModelAccess,
  ModelPolicy,
  PolicyGroup,
  ProviderPolicy,
  RouteLimits,
  RoutePolicy,
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
  return groups.map((group) => ({
    alias: group.alias,
    routes: reachable(group.alias, byAlias)
      .flatMap((node) => node.providerIds)
      .map((id) => (id ? (byId.get(id) ?? null) : null)),
  }));
}

export function dataRuleOf(rules: DeploymentRule): DeploymentRule | null {
  const limited =
    rules.providerIds.length > 0 ||
    rules.regions.length > 0 ||
    rules.zdrOnly ||
    rules.noTrainingOnly ||
    rules.maxRetentionDays !== null;
  if (!limited) return null;
  return {
    providerIds: rules.providerIds,
    regions: rules.regions,
    zdrOnly: rules.zdrOnly,
    noTrainingOnly: rules.noTrainingOnly,
    maxRetentionDays: rules.maxRetentionDays,
  };
}

export function routeAllowed(rule: DeploymentRule, route: RoutePolicy): boolean {
  if (!route) return false;
  if (rule.providerIds.length && !rule.providerIds.includes(route.id)) return false;
  if (rule.zdrOnly && !route.zdr) return false;
  if (rule.noTrainingOnly && !route.zdr && !route.noTraining) return false;
  if (rule.maxRetentionDays !== null) {
    const days = route.zdr ? 0 : route.retentionDays;
    if (days === null || days > rule.maxRetentionDays) return false;
  }
  if (rule.regions.length && !rule.regions.includes(route.region)) return false;
  return true;
}

export function routePermitted(rules: DeploymentRule[] | undefined, route: RoutePolicy): boolean {
  return !rules || rules.some((rule) => routeAllowed(rule, route));
}

export function templateMatches(rules: TemplateRules, policy: ModelPolicy): boolean {
  if (rules.models.includes(policy.alias)) return true;
  if (!hasRules(rules)) return false;
  if (rules.patterns.length && !rules.patterns.some((pattern) => patternMatches(pattern, policy.alias))) {
    return false;
  }
  const rule = dataRuleOf(rules);
  return !rule || policy.routes.some((route) => routeAllowed(rule, route));
}

export function templateModels(rules: TemplateRules, policies: ModelPolicy[]): string[] {
  const matched = policies.filter((policy) => templateMatches(rules, policy)).map((policy) => policy.alias);
  return [...new Set([...matched, ...rules.models])];
}

export function resolveAccess(
  explicit: string[],
  templates: TemplateRules[],
  policies: ModelPolicy[],
): ModelAccess {
  const open = new Set(explicit);
  const limited = new Map<string, DeploymentRule[]>();
  for (const rules of templates) {
    for (const alias of rules.models) open.add(alias);
    const rule = dataRuleOf(rules);
    for (const policy of policies) {
      if (rules.models.includes(policy.alias) || !templateMatches(rules, policy)) continue;
      if (!rule) open.add(policy.alias);
      else limited.set(policy.alias, [...(limited.get(policy.alias) ?? []), rule]);
    }
  }
  const limits: RouteLimits = {};
  if (!open.has("*")) {
    for (const [alias, rules] of limited) if (!open.has(alias)) limits[alias] = rules;
  }
  return { models: [...new Set([...open, ...limited.keys()])], limits };
}
