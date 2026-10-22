import type { z } from "zod";
import type {
  guardrailPolicySchema,
  guardrailRuleSchema,
  piiDetectorSettingsSchema,
  piiPolicySchema,
  policyScopeSchema,
} from "@/schemas/guardrails";

export type PolicyScope = z.infer<typeof policyScopeSchema>;

export type PiiPolicy = z.infer<typeof piiPolicySchema>;

export type PiiMode = PiiPolicy["mode"];

export type PiiDetectorSettings = z.infer<typeof piiDetectorSettingsSchema>;

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

export type GuardrailPolicy = z.infer<typeof guardrailPolicySchema>;

export type InjectionPolicy = GuardrailPolicy["injection"];

export type InjectionAction = InjectionPolicy["action"];

export type InjectionCheck = InjectionPolicy["checks"][number];

export type GuardrailOverrideView = PolicyTarget & { policy: GuardrailPolicy };

export type PiiSummary = { enabled: boolean; mode: PiiMode; output: boolean; entities: number; detector: PiiDetector };

export type GuardrailSummary = {
  injection: InjectionAction | null;
  secrets: GuardrailAction | null;
  rules: number;
};

export type PolicyLevel = "global" | "org";

export type PolicyOverrideSummary = PolicyTarget & {
  pii: PiiSummary | null;
  guardrails: GuardrailSummary | null;
};

export type CompanyPolicies = {
  pii: PiiSummary & { level: PolicyLevel };
  guardrails: GuardrailSummary & { level: PolicyLevel };
  overrides: PolicyOverrideSummary[];
};

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
  modelOnly?: boolean;
};

export type PiiRule = { id: string; apply: (text: string) => string };

export type PiiDetector = PiiPolicy["detector"];

export type PiiFailure = PiiPolicy["failure"];

export type PiiSpan = { entity: string; start: number; end: number; score: number; source: "model" | "pattern" };

export type PiiModelSpan = Omit<PiiSpan, "source">;

export type PiiModelTest = {
  model: string;
  ok: boolean;
  latencyMs: number;
  status: number;
  error: string;
  spans: PiiModelSpan[];
};
