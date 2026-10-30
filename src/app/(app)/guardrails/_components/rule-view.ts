import type { GuardrailRule } from "@/types/guardrails";

const TERM_CHARS = 40;

export function newRuleId(): string {
  return `rule_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function newRule(name: string): GuardrailRule {
  return {
    id: newRuleId(),
    name,
    kind: "denylist",
    target: "input",
    action: "block",
    patterns: [""],
    caseSensitive: false,
  };
}

function shorten(term: string): string {
  return term.length > TERM_CHARS ? `${term.slice(0, TERM_CHARS - 1)}…` : term;
}

export function rulePatterns(rule: Pick<GuardrailRule, "patterns">): string[] {
  return [...new Set(rule.patterns.map((pattern) => pattern.trim()).filter(Boolean))];
}

export function previewTerms(rule: Pick<GuardrailRule, "patterns">, limit = 3): { shown: string[]; more: number } {
  const patterns = rulePatterns(rule);
  return { shown: patterns.slice(0, limit).map(shorten), more: Math.max(0, patterns.length - limit) };
}

export function ruleMatches(rule: GuardrailRule, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return rule.name.toLowerCase().includes(needle) || rule.patterns.some((pattern) => pattern.toLowerCase().includes(needle));
}

export function upsertRule(rules: readonly GuardrailRule[], rule: GuardrailRule): GuardrailRule[] {
  return rules.some((row) => row.id === rule.id)
    ? rules.map((row) => (row.id === rule.id ? rule : row))
    : [...rules, rule];
}

export function withoutRule(rules: readonly GuardrailRule[], id: string): GuardrailRule[] {
  return rules.filter((rule) => rule.id !== id);
}

export function nextRuleName(rules: readonly GuardrailRule[], nameFor: (n: number) => string): string {
  const taken = new Set(rules.map((rule) => rule.name.trim().toLowerCase()));
  let n = rules.length + 1;
  while (taken.has(nameFor(n).trim().toLowerCase())) n += 1;
  return nameFor(n);
}
