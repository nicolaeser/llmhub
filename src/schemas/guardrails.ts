import { z } from "zod";
import {
  GUARDRAIL_ACTIONS,
  INJECTION_CHECKS,
  MAX_PATTERN_LENGTH,
  MAX_RULE_NAME,
  MAX_RULE_PATTERNS,
  MAX_RULES,
  MAX_TEST_TEXT,
  patternIssue,
  RULE_KINDS,
  RULE_TARGETS,
  SECRET_ENTITIES,
} from "@/lib/gateway/safety/guardrails";
import { PII_DETECTORS, PII_FAILURES } from "@/lib/gateway/safety/pii";

export const PII_TIMEOUT_MIN_SECONDS = 1;
export const PII_TIMEOUT_MAX_SECONDS = 120;
export const PII_TIMEOUT_DEFAULT_SECONDS = 30;
export const MAX_PII_TEST_TEXT = 4_000;

export const policyScopeSchema = z.enum(["org", "project", "key"]);

const targetId = z.string().trim().min(1).max(64);

export const piiPolicySchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["mask", "block", "restore"]),
  output: z.boolean(),
  entities: z.array(z.string().trim().min(1).max(64)).max(100),
  detector: z.enum(PII_DETECTORS).default("patterns"),
  failure: z.enum(PII_FAILURES).default("patterns"),
});

export const piiDetectorSettingsSchema = z.object({
  model: z.string().trim().max(200),
  timeout_seconds: z.number().int().min(PII_TIMEOUT_MIN_SECONDS).max(PII_TIMEOUT_MAX_SECONDS),
});

export const piiModelTestSchema = z.object({
  model: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(MAX_PII_TEST_TEXT),
});

export const piiOverrideSchema = z.object({
  scope: policyScopeSchema,
  id: targetId,
  policy: piiPolicySchema.nullable(),
});

export const guardrailRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(MAX_RULE_NAME),
    kind: z.enum(RULE_KINDS),
    target: z.enum(RULE_TARGETS),
    action: z.enum(GUARDRAIL_ACTIONS),
    patterns: z.array(z.string().max(MAX_PATTERN_LENGTH)).max(MAX_RULE_PATTERNS),
    caseSensitive: z.boolean(),
  })
  .superRefine((rule, ctx) => {
    const patterns = rule.patterns.map((pattern) => pattern.trim());
    if (!patterns.some(Boolean)) ctx.addIssue({ code: "custom", path: ["patterns"], message: "empty" });
    if (rule.kind !== "regex") return;
    patterns.forEach((pattern, index) => {
      const issue = pattern ? patternIssue(pattern) : null;
      if (issue) ctx.addIssue({ code: "custom", path: ["patterns", index], message: issue });
    });
  });

export const guardrailPolicySchema = z
  .object({
    injection: z.object({
      enabled: z.boolean(),
      action: z.enum(["block", "flag"]),
      checks: z.array(z.enum(INJECTION_CHECKS)).max(INJECTION_CHECKS.length),
    }),
    secrets: z.object({
      enabled: z.boolean(),
      action: z.enum(GUARDRAIL_ACTIONS),
      entities: z
        .array(z.string().refine((id) => SECRET_ENTITIES.includes(id)))
        .max(SECRET_ENTITIES.length),
    }),
    rules: z.array(guardrailRuleSchema).max(MAX_RULES),
  })
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    policy.rules.forEach((rule, index) => {
      const name = rule.name.trim().toLowerCase();
      if (seen.has(name)) ctx.addIssue({ code: "custom", path: ["rules", index, "name"], message: "duplicate" });
      seen.add(name);
    });
  });

export const guardrailOverrideSchema = z.object({
  scope: policyScopeSchema,
  id: targetId,
  policy: guardrailPolicySchema.nullable(),
});

export const guardrailTestSchema = z.object({
  text: z.string().max(MAX_TEST_TEXT),
  direction: z.enum(["input", "output"]),
  policy: guardrailPolicySchema,
});
