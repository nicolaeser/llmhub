import type { z } from "zod";
import type {
  guardrailPolicySchema,
  guardrailRuleSchema,
  piiDetectorSettingsSchema,
  piiPolicySchema,
  POLICY_SECTIONS,
  policyRefSchema,
  policyScopeSchema,
} from "@/schemas/guardrails";

export type PolicyScope = z.infer<typeof policyScopeSchema>;

export type PolicySection = (typeof POLICY_SECTIONS)[number];

export type PolicyRef = z.infer<typeof policyRefSchema>;

export type PiiPolicy = z.infer<typeof piiPolicySchema>;

export type PiiMode = PiiPolicy["mode"];

export type PiiDetectorSettings = z.infer<typeof piiDetectorSettingsSchema>;

export type PolicyTarget = PolicyRef & {
  alias: string;
  orgId: string;
  teamId: string;
  projectId: string;
  path: string[];
};

export type GuardrailRule = z.infer<typeof guardrailRuleSchema>;

export type GuardrailAction = GuardrailRule["action"];

export type GuardrailPolicy = z.infer<typeof guardrailPolicySchema>;

export type InjectionPolicy = GuardrailPolicy["injection"];

export type InjectionAction = InjectionPolicy["action"];

export type InjectionCheck = InjectionPolicy["checks"][number];

export type SecretsPolicy = GuardrailPolicy["secrets"];

export type PolicyLayer = {
  pii: PiiPolicy | null;
  injection: InjectionPolicy | null;
  secrets: SecretsPolicy | null;
  rules: GuardrailRule[] | null;
};

export type PolicyOverrideView = PolicyLayer & { target: PolicyTarget; updatedAt: string };

export type PlatformPolicies = { pii: PiiPolicy; guardrails: GuardrailPolicy };

export type EffectivePolicies = PlatformPolicies & { sources: Record<PolicySection, PolicyRef | null> };

export type SectionState = "off" | "on" | PiiMode | GuardrailAction;

export type SectionSummary = { section: PolicySection; state: SectionState; count: number };

export type PolicyLevel = "global" | "org";

export type PolicyOverrideSummary = PolicyTarget & { sections: SectionSummary[] };

export type CompanyPolicies = {
  sections: (SectionSummary & { level: PolicyLevel })[];
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

export type PolicyTestResult = GuardrailTestResult & {
  blockedBy: "guardrail" | "pii" | null;
  pii: string[];
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
