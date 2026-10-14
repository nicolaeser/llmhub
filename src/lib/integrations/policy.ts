import type { PolicyContext, PolicyDecision, PolicyRule, SideEffect } from "@/types/integrations";

const EFFECTS = new Set<SideEffect>(["read", "write", "destructive", "sensitive"]);

function listed(values: readonly string[] | undefined, value: string): boolean {
  if (!values?.length) return true;
  return values.includes("*") || values.includes(value);
}

function resourceMatches(patterns: readonly string[] | undefined, resource: string): boolean {
  if (!patterns?.length) return true;
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("*")) return resource.startsWith(pattern.slice(0, -1));
    return pattern === resource;
  });
}

function parametersMatch(rule: PolicyRule, parameters: Record<string, unknown>): boolean {
  if (!rule.parameters) return true;
  for (const [key, constraint] of Object.entries(rule.parameters)) {
    if (!Object.hasOwn(parameters, key)) continue;
    const value = parameters[key];
    if (constraint.enum && !constraint.enum.includes(String(value))) return false;
    if (constraint.maxLength !== undefined && String(value).length > constraint.maxLength) return false;
    if (constraint.pattern) {
      try {
        if (!new RegExp(constraint.pattern).test(String(value))) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

function timeMatches(rule: PolicyRule, now: Date): boolean {
  if (rule.notBefore && now.toISOString() < rule.notBefore) return false;
  if (rule.notAfter && now.toISOString() > rule.notAfter) return false;
  return true;
}

export function ruleMatches(rule: PolicyRule, ctx: PolicyContext): boolean {
  if (!listed(rule.tools, ctx.tool)) return false;
  if (!listed(rule.operations, ctx.operation)) return false;
  if (rule.effects?.length && !rule.effects.includes(ctx.sideEffect)) return false;
  if (!resourceMatches(rule.resources, ctx.resource)) return false;
  if (rule.environments?.length && !rule.environments.includes(ctx.environment)) return false;
  if (!parametersMatch(rule, ctx.parameters)) return false;
  if (!timeMatches(rule, ctx.now)) return false;
  return true;
}

export function evaluatePolicy(rules: readonly PolicyRule[], ctx: PolicyContext, version = 1): PolicyDecision {
  const matched = rules.filter((rule) => ruleMatches(rule, ctx));
  const deny = matched.find((rule) => rule.effect === "deny");
  if (deny) {
    return {
      decision: "deny",
      approval: false,
      reason: "deny_rule",
      matched: "deny",
      denyFields: [],
      quotaRpm: null,
      policyVersion: version,
    };
  }
  const allows = matched.filter((rule) => rule.effect === "allow");
  if (!allows.length) {
    return {
      decision: "deny",
      approval: false,
      reason: "deny_by_default",
      matched: "default",
      denyFields: [],
      quotaRpm: null,
      policyVersion: version,
    };
  }
  const denyFields = [...new Set(allows.flatMap((rule) => rule.denyFields ?? []))];
  const quota = allows.map((rule) => rule.quotaRpm).filter((value): value is number => typeof value === "number");
  return {
    decision: "allow",
    approval: allows.some((rule) => rule.approval === true),
    reason: "allow_rule",
    matched: "allow",
    denyFields,
    quotaRpm: quota.length ? Math.min(...quota) : null,
    policyVersion: version,
  };
}

export function isSideEffect(value: string): value is SideEffect {
  return EFFECTS.has(value as SideEffect);
}

export function stripFields(value: unknown, fields: readonly string[]): unknown {
  if (!fields.length || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripFields(item, fields));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (fields.includes(key)) continue;
    out[key] = stripFields(item, fields);
  }
  return out;
}

export function readablePolicy(rules: readonly PolicyRule[]): { allow: string[]; deny: string[] } {
  const allow = rules.filter((rule) => rule.effect === "allow").flatMap((rule) => rule.operations ?? rule.tools ?? ["*"]);
  const deny = rules.filter((rule) => rule.effect === "deny").flatMap((rule) => rule.operations ?? rule.effects ?? ["*"]);
  return { allow, deny };
}
