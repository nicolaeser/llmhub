import type { z } from "zod";
import type { guardrailOverrideSchema, piiOverrideSchema, policyScopeSchema } from "@/schemas/guardrails";
import type { GUARDRAIL_ACTIONS, INJECTION_CHECKS, RULE_KINDS, RULE_TARGETS } from "@/lib/gateway/guardrails";

export type PiiMode = "mask" | "block";

export type PolicyScope = z.infer<typeof policyScopeSchema>;

export type PiiPolicy = {
  enabled: boolean;
  mode: PiiMode;
  output: boolean;
  entities: string[];
};

export type PiiOverrideInput = z.infer<typeof piiOverrideSchema>;

export type PolicyTarget = {
  scope: PolicyScope;
  id: string;
  alias: string;
  orgId: string;
  projectId: string;
};

export type PiiOverrideView = PolicyTarget & { policy: PiiPolicy };

export type GuardrailAction = (typeof GUARDRAIL_ACTIONS)[number];

export type InjectionAction = Exclude<GuardrailAction, "mask">;

export type InjectionCheck = (typeof INJECTION_CHECKS)[number];

export type RuleKind = (typeof RULE_KINDS)[number];

export type RuleTarget = (typeof RULE_TARGETS)[number];

export type GuardrailRule = {
  id: string;
  name: string;
  kind: RuleKind;
  target: RuleTarget;
  action: GuardrailAction;
  patterns: string[];
  caseSensitive: boolean;
};

export type InjectionPolicy = {
  enabled: boolean;
  action: InjectionAction;
  checks: InjectionCheck[];
};

export type SecretPolicy = {
  enabled: boolean;
  action: GuardrailAction;
  entities: string[];
};

export type GuardrailPolicy = {
  injection: InjectionPolicy;
  secrets: SecretPolicy;
  rules: GuardrailRule[];
};

export type GuardrailOverrideInput = z.infer<typeof guardrailOverrideSchema>;

export type GuardrailOverrideView = PolicyTarget & { policy: GuardrailPolicy };

export type PatternIssue = "invalid" | "nested_quantifier" | "matches_empty";

export type RuleIssue = {
  field: "name" | "patterns";
  issue: PatternIssue | "empty" | "duplicate";
  line: number;
};

export type GuardrailDirection = "input" | "output";

export type CompiledRule = {
  hit: string;
  action: GuardrailAction;
  matches: (text: string) => boolean;
  mask: (text: string) => string;
};

export type OutputGuard = {
  pii: string[] | null;
  rules: CompiledRule[];
};

export type ScreenResult = {
  text: string;
  blocked: boolean;
};

export type GuardrailTestResult = {
  text: string;
  hits: string[];
  blocked: boolean;
};
