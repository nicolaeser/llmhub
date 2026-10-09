import { PII_CATALOG, redactPii, skipsScan } from "@/lib/gateway/pii";
import type { JsonMap, RequestTrace } from "@/types/gateway";
import type {
  CompiledRule,
  GuardrailAction,
  GuardrailDirection,
  GuardrailPolicy,
  GuardrailRule,
  GuardrailTestResult,
  InjectionCheck,
  OutputGuard,
  PatternIssue,
  RuleIssue,
  ScreenResult,
} from "@/types/guardrails";

export const GUARDRAIL_ACTIONS = ["block", "mask", "flag"] as const;

export const INJECTION_CHECKS = [
  "instruction_override",
  "prompt_leak",
  "role_hijack",
  "delimiter",
  "hidden_text",
] as const;

export const RULE_KINDS = ["denylist", "regex"] as const;

export const RULE_TARGETS = ["input", "output", "both"] as const;

export const SECRET_ENTITIES = PII_CATALOG.filter((e) => e.category === "Credentials").map((e) => e.id);

export const MAX_RULES = 50;
export const MAX_RULE_PATTERNS = 200;
export const MAX_PATTERN_LENGTH = 300;
export const MAX_RULE_NAME = 60;
export const MAX_TEST_TEXT = 20_000;

export const GUARDRAIL_MASK = "[REDACTED]";

const STREAM_WINDOW = 256;
const TRUSTED_KEYS = new Set(["system", "instructions"]);
const TRUSTED_ROLES = new Set(["system", "developer"]);
const ACTION_ORDER: Record<GuardrailAction, number> = { block: 0, flag: 1, mask: 2 };

const INJECTION_PATTERNS: Record<InjectionCheck, RegExp[]> = {
  instruction_override: [
    /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|every|the|your|of|these|those)\s+){0,3}(?:(?:previous|prior|preceding|above|earlier|initial|original|system|developer|existing|safety)\s+){1,2}(?:instructions?|prompts?|rules|directives?|guidelines|guardrails|constraints|messages?)\b/iu,
    /\b(?:ignore|disregard|forget)\s+(?:all\s+(?:of\s+)?)?your\s+(?:system\s+)?(?:instructions|rules|guidelines|programming|constraints)\b/iu,
    /\b(?:ignorier(?:e|en|t)?|missachte|vergiss|vergesst|verwirf)\s+(?:(?:alle|sämtliche|die|deine|eure|ihre|jegliche)\s+){0,2}(?:vorherigen|bisherigen|obigen|vorigen|vorangegangenen|ursprünglichen|früheren)\s+(?:system-?)?(?:anweisungen|instruktionen|regeln|vorgaben|richtlinien|befehle|prompts?)/iu,
    /\b(?:ignorier(?:e|en|t)?|missachte|vergiss|vergesst)\s+(?:alle\s+)?(?:deine|eure|ihre|jegliche|sämtliche)\s+(?:system-?)?(?:anweisungen|instruktionen|regeln|vorgaben|richtlinien)/iu,
    /\b(?:ignorier(?:e|en|t)?|missachte|vergiss|vergesst)\s+(?:(?:alle|die|deine|den|deinen)\s+){0,2}system-?\s?(?:anweisungen|prompts?|nachrichten?|regeln)/iu,
  ],
  prompt_leak: [
    /\b(?:reveal|show|print|output|display|repeat|tell|give|leak|dump|share|recite|write\s+out|spell\s+out)\s+(?:me\s+|us\s+)?(?:(?:your|the|its|full|entire|complete|exact|original|initial|hidden|secret|verbatim|whole)\s+){0,3}(?:system\s+(?:prompt|message|instructions?)|(?:hidden|secret|initial|original|developer)\s+(?:prompt|instructions?|message))\b/iu,
    /\bwhat\s+(?:is|are|was|were)\s+(?:your|the)\s+(?:system\s+prompt|(?:initial|original|hidden|secret|system)\s+instructions)\b/iu,
    /\brepeat\s+(?:all\s+|everything\s+|the\s+)?(?:words|text|everything|content)\s+(?:above|before\s+this)\b/iu,
    /\b(?:zeig(?:e)?|gib|nenne|verrate|wiederhole|schreib(?:e)?|drucke)\s+(?:mir\s+|uns\s+)?(?:(?:deinen|deine|dein|den|die|das|ihren|ihre|vollständigen|vollständige|genauen|genaue|ursprünglichen|ursprüngliche)\s+){0,3}(?:system-?\s?(?:prompt|anweisungen?|nachricht|instruktionen)|(?:versteckten|geheimen|ursprünglichen)\s+(?:anweisungen|instruktionen))/iu,
    /\bwas\s+(?:ist|sind|war|waren)\s+(?:dein|deine|der|die)\s+system-?\s?(?:prompt|anweisungen)/iu,
  ],
  role_hijack: [
    /\byou\s+are\s+(?:now\s+)?(?:in\s+)?(?:developer\s+mode|god\s+mode|jailbroken|jailbreak\s+mode)\b/iu,
    /\byou\s+are\s+now\s+(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|unaligned|evil)\b/iu,
    /\b(?:developer|god|jailbreak|debug)\s+mode\s+(?:is\s+)?(?:enabled|activated|unlocked|on)\b/iu,
    /\b(?:[Yy]ou\s+are\s+(?:now\s+)?|[Aa]ct\s+as\s+|[Pp]retend\s+to\s+be\s+)DAN\b|\bDAN\s+mode\b/u,
    /\bdo\s+anything\s+now\b/iu,
    /\b(?:act|behave|respond|answer)\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken|unaligned)\b/iu,
    /\bpretend\s+(?:that\s+)?(?:you\s+(?:have|had)\s+no|there\s+are\s+no)\s+(?:restrictions|rules|guidelines|filters|limits|limitations|content\s+polic(?:y|ies))\b/iu,
    /\bdu\s+bist\s+(?:jetzt|nun|ab\s+sofort|ab\s+jetzt)\s+(?:im\s+|ein(?:e)?\s+)?(?:DAN|Entwicklermodus|Developer-?\s?Mode|uneingeschränkt(?:e|er)?|ungefiltert(?:e|er)?|unzensiert(?:e|er)?|jailbroken)/iu,
    /\b(?:tu|tue)\s+so,?\s+als\s+(?:ob\s+du\s+keine|hättest\s+du\s+keine|gäbe\s+es\s+keine)\s+(?:Regeln|Einschränkungen|Richtlinien|Filter|Grenzen)/iu,
    /\bEntwicklermodus\s+(?:ist\s+)?(?:aktiviert|aktiv|an|eingeschaltet)\b/iu,
  ],
  delimiter: [
    /<\|(?:im_start|im_end|system|user|assistant|endoftext|start_header_id|end_header_id|eot_id|begin_of_text)\|>/iu,
    /\[\/?INST\]|<<\/?SYS>>/u,
    /<\/?(?:system|system_prompt|sys)>/iu,
    /\b(?:BEGIN|END)\s+(?:OF\s+)?SYSTEM\s+(?:PROMPT|MESSAGE|INSTRUCTIONS)\b/iu,
    /(?:^|\n)[ \t]*#{2,}[ \t]*(?:new[ \t]+)?(?:system|admin|developer)[ \t]+(?:prompt|instructions?|message|override)\b/iu,
  ],
  hidden_text: [/[\u{E0000}-\u{E007F}]/u, /[\u200B-\u200D\u2060\uFEFF]{4,}/u, /[\u202D\u202E]/u],
};

export function defaultGuardrails(): GuardrailPolicy {
  return {
    injection: { enabled: false, action: "flag", checks: [...INJECTION_CHECKS] },
    secrets: { enabled: false, action: "mask", entities: [...SECRET_ENTITIES] },
    rules: [],
  };
}

export function ruleHit(name: string): string {
  return `rule:${name}`;
}

export function injectionHit(check: InjectionCheck): string {
  return `injection:${check}`;
}

export function secretHit(entity: string): string {
  return `secret:${entity}`;
}

export function parseHit(hit: string): { kind: string; value: string } {
  const at = hit.indexOf(":");
  return at < 0 ? { kind: "rule", value: hit } : { kind: hit.slice(0, at), value: hit.slice(at + 1) };
}

function quantifierAt(pattern: string, index: number): { length: number; varies: boolean; repeats: boolean } | null {
  const ch = pattern[index];
  let length = 1;
  let min = 0;
  let max = Number.POSITIVE_INFINITY;
  if (ch === "?") max = 1;
  else if (ch === "+") min = 1;
  else if (ch === "{") {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
    if (!match) return null;
    length = match[0].length;
    min = Number(match[1]);
    max = match[2] === undefined ? min : match[3] ? Number(match[3]) : Number.POSITIVE_INFINITY;
  } else if (ch !== "*") return null;
  if (pattern[index + length] === "?") length += 1;
  const varies = max > min;
  return { length, varies, repeats: varies && max > 1 };
}

function groupPrefixLength(pattern: string, index: number): number {
  if (pattern[index] !== "?") return 0;
  const named = /^\?<[A-Za-z_$][\w$]*>/.exec(pattern.slice(index));
  if (named) return named[0].length;
  return pattern.startsWith("?<=", index) || pattern.startsWith("?<!", index) ? 3 : 2;
}

export function hasNestedQuantifier(pattern: string): boolean {
  const groups: boolean[] = [];
  let inClass = false;
  let afterGroup = false;
  let groupVaries = false;
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 2;
      afterGroup = false;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      i += 1;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      afterGroup = false;
      i += 1;
      continue;
    }
    if (ch === "(") {
      groups.push(false);
      i += 1 + groupPrefixLength(pattern, i + 1);
      afterGroup = false;
      continue;
    }
    if (ch === ")") {
      groupVaries = groups.pop() ?? false;
      if (groupVaries && groups.length) groups[groups.length - 1] = true;
      afterGroup = true;
      i += 1;
      continue;
    }
    const quantifier = quantifierAt(pattern, i);
    if (quantifier) {
      if (afterGroup && groupVaries && quantifier.repeats) return true;
      if (quantifier.varies && groups.length) groups[groups.length - 1] = true;
      afterGroup = false;
      i += quantifier.length;
      continue;
    }
    afterGroup = false;
    i += 1;
  }
  return false;
}

export function patternIssue(pattern: string): PatternIssue | null {
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "u");
  } catch {
    return "invalid";
  }
  if (hasNestedQuantifier(pattern)) return "nested_quantifier";
  if (expression.test("")) return "matches_empty";
  return null;
}

export function ruleIssue(rule: GuardrailRule, rules: GuardrailRule[]): RuleIssue | null {
  const name = rule.name.trim().toLowerCase();
  if (!name) return { field: "name", issue: "empty", line: 0 };
  if (rules.some((other) => other.id !== rule.id && other.name.trim().toLowerCase() === name)) {
    return { field: "name", issue: "duplicate", line: 0 };
  }
  if (!rule.patterns.some((pattern) => pattern.trim())) return { field: "patterns", issue: "empty", line: 0 };
  if (rule.kind !== "regex") return null;
  for (const [index, line] of rule.patterns.entries()) {
    const issue = line.trim() ? patternIssue(line.trim()) : null;
    if (issue) return { field: "patterns", issue, line: index + 1 };
  }
  return null;
}

export function guardrailsValid(policy: GuardrailPolicy): boolean {
  return policy.rules.every((rule) => !ruleIssue(rule, policy.rules));
}

function escapeTerm(term: string): string {
  return term.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&").replace(/\s+/g, "\\s+");
}

function ruleExpressions(rule: GuardrailRule): RegExp[] {
  const flags = rule.caseSensitive ? "gu" : "giu";
  const patterns = [...new Set(rule.patterns.map((p) => p.trim()).filter(Boolean))];
  if (!patterns.length) return [];
  if (rule.kind === "denylist") {
    const terms = patterns.sort((a, b) => b.length - a.length).map(escapeTerm);
    return [new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.join("|")})(?![\\p{L}\\p{N}_])`, flags)];
  }
  return patterns.filter((p) => !patternIssue(p)).map((p) => new RegExp(p, flags));
}

export function compileRule(rule: GuardrailRule): CompiledRule | null {
  const expressions = ruleExpressions(rule);
  if (!expressions.length) return null;
  return {
    hit: ruleHit(rule.name || rule.id),
    action: rule.action,
    matches: (text) => expressions.some((expression) => text.search(expression) >= 0),
    mask: (text) => expressions.reduce((out, expression) => out.replace(expression, GUARDRAIL_MASK), text),
  };
}

function secretRule(entity: string, action: GuardrailAction): CompiledRule {
  return {
    hit: secretHit(entity),
    action,
    matches: (text) => redactPii(text, [entity]) !== text,
    mask: (text) => redactPii(text, [entity]),
  };
}

function ordered(rules: (CompiledRule | null)[]): CompiledRule[] {
  return rules
    .filter((rule): rule is CompiledRule => rule !== null)
    .sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action]);
}

export function detectInjection(text: string, checks: readonly InjectionCheck[]): InjectionCheck[] {
  return checks.filter((check) => INJECTION_PATTERNS[check].some((expression) => expression.test(text)));
}

export function screenText(value: string, rules: CompiledRule[], hits: Set<string>, context = value): ScreenResult {
  let text = value;
  let blocked = false;
  for (const rule of rules) {
    if (rule.action === "mask") {
      const next = rule.mask(text);
      if (next !== text) hits.add(rule.hit);
      text = next;
      continue;
    }
    if (!rule.matches(context)) continue;
    hits.add(rule.hit);
    if (rule.action === "block") blocked = true;
  }
  return { text, blocked };
}

type RequestScan = {
  rules: CompiledRule[];
  checks: readonly InjectionCheck[];
  injectionBlocks: boolean;
  hits: Set<string>;
  blocked: boolean;
};

function scanRequestValue(value: unknown, key: string, trusted: boolean, scan: RequestScan): unknown {
  if (typeof value === "string") {
    if (skipsScan(key, value)) return value;
    if (!trusted) {
      for (const check of detectInjection(value, scan.checks)) {
        scan.hits.add(injectionHit(check));
        if (scan.injectionBlocks) scan.blocked = true;
      }
    }
    const result = screenText(value, scan.rules, scan.hits);
    if (result.blocked) scan.blocked = true;
    return result.text;
  }
  if (Array.isArray(value)) return value.map((item) => scanRequestValue(item, key, trusted, scan));
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const inner = trusted || (typeof rec.role === "string" && TRUSTED_ROLES.has(rec.role));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = scanRequestValue(v, k, inner || TRUSTED_KEYS.has(k), scan);
    return out;
  }
  return value;
}

export function screenRequest(
  body: JsonMap,
  policy: GuardrailPolicy,
  hits: Set<string>,
): { body: JsonMap; blocked: boolean } {
  const rules = ordered(policy.rules.filter((rule) => rule.target !== "output").map(compileRule));
  const checks = !policy.injection.enabled
    ? []
    : policy.injection.checks.length
      ? policy.injection.checks
      : INJECTION_CHECKS;
  if (!rules.length && !checks.length) return { body, blocked: false };
  const scan: RequestScan = {
    rules,
    checks,
    injectionBlocks: policy.injection.action === "block",
    hits,
    blocked: false,
  };
  return { body: scanRequestValue(body, "", false, scan) as JsonMap, blocked: scan.blocked };
}

export function outputGuard(policy: GuardrailPolicy, pii: string[] | null): OutputGuard | null {
  const secrets = policy.secrets.enabled
    ? (policy.secrets.entities.length ? policy.secrets.entities : SECRET_ENTITIES).map((entity) =>
        secretRule(entity, policy.secrets.action),
      )
    : [];
  const rules = ordered([...policy.rules.filter((rule) => rule.target !== "input").map(compileRule), ...secrets]);
  if (!rules.length && !pii) return null;
  return { pii, rules };
}

export class OutputScreen {
  blocked = false;
  private tail = "";
  private readonly guard: OutputGuard;
  private readonly trace: RequestTrace | undefined;

  constructor(guard: OutputGuard, trace?: RequestTrace) {
    this.guard = guard;
    this.trace = trace;
  }

  text(value: string): string {
    return this.apply(value, value);
  }

  delta(value: string): string {
    const context = this.tail + value;
    this.tail = context.slice(-STREAM_WINDOW);
    return this.apply(value, context);
  }

  private apply(value: string, context: string): string {
    const result = screenText(value, this.guard.rules, this.trace?.guardOutput ?? new Set(), context);
    if (result.blocked) {
      this.blocked = true;
      if (this.trace) this.trace.guardBlocked = true;
    }
    return this.guard.pii ? redactPii(result.text, this.guard.pii, this.trace?.piiOutput) : result.text;
  }
}

export function outputScreen(guard: OutputGuard | null, trace?: RequestTrace): OutputScreen | null {
  return guard ? new OutputScreen(guard, trace) : null;
}

export function testGuardrails(
  text: string,
  policy: GuardrailPolicy,
  direction: GuardrailDirection,
): GuardrailTestResult {
  const hits = new Set<string>();
  if (direction === "input") {
    const screened = screenRequest({ text }, policy, hits);
    const out = screened.body.text;
    return { text: typeof out === "string" ? out : text, hits: [...hits], blocked: screened.blocked };
  }
  const guard = outputGuard(policy, null);
  if (!guard) return { text, hits: [], blocked: false };
  const result = screenText(text, guard.rules, hits);
  return { text: result.text, hits: [...hits], blocked: result.blocked };
}
