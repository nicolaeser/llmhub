import type { z } from "zod";
import type {
  guardrailOverrideSchema,
  guardrailPolicySchema,
  guardrailRuleSchema,
  piiOverrideSchema,
  piiPolicySchema,
  policyScopeSchema,
} from "@/schemas/guardrails";

export type PolicyScope = z.infer<typeof policyScopeSchema>;

export type PiiPolicy = z.infer<typeof piiPolicySchema>;

export type PiiMode = PiiPolicy["mode"];

export type PiiOverrideInput = z.infer<typeof piiOverrideSchema>;

export type PolicyTarget = {
  scope: PolicyScope;
  id: string;
  alias: string;
  orgId: string;
  projectId: string;
};

export type PiiOverrideView = PolicyTarget & { policy: PiiPolicy };

export type GuardrailRule = z.infer<typeof guardrailRuleSchema>;

export type GuardrailAction = GuardrailRule["action"];

export type RuleKind = GuardrailRule["kind"];

export type RuleTarget = GuardrailRule["target"];

export type GuardrailPolicy = z.infer<typeof guardrailPolicySchema>;

export type InjectionPolicy = GuardrailPolicy["injection"];

export type InjectionAction = InjectionPolicy["action"];

export type InjectionCheck = InjectionPolicy["checks"][number];

export type SecretPolicy = GuardrailPolicy["secrets"];

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

export type PiiEntity = {
  id: string;
  label: string;
  category: string;
  example: string;
  default?: boolean;
};

export type PiiRule = { id: string; apply: (text: string) => string };
