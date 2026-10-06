import { z } from "zod";
import { assistantPages, assistantTopics } from "@/lib/assistant/knowledge";
import { DATA_REGIONS } from "@/lib/gateway/model-policy";
import type { UsageBreakdownGroup, UsageBreakdownSort } from "@/types/assistant";

const id = z.string().trim().min(1).max(64);
const name = z.string().trim().min(1).max(200);
const label = z.string().trim().max(200);
const names = (max: number) => z.array(name).max(max);
const confirm = z
  .boolean()
  .default(false)
  .describe("Set true only after the operator explicitly confirmed this action in the conversation.");
const strategy = z.enum(["least_inflight", "weighted_random", "cost_lowest", "priority", "fast"]);
const budgetKind = z.enum(["org", "team", "project", "member", "user", "key"]);
const nodeKind = z.enum(["org", "team", "project", "member"]);
const usageGroups = ["model", "org", "team", "project", "member", "key", "user"] as const satisfies readonly UsageBreakdownGroup[];
const usageSorts = ["spend", "requests", "errors"] as const satisfies readonly UsageBreakdownSort[];
const keyRef = name.describe("Key id, alias, or prefix.");
const days = z.number().int().min(0).max(3650);
const rpm = z.number().int().min(0).max(1_000_000);
const tpm = z.number().int().min(0).max(1_000_000_000);
const providerPolicy = {
  zdr: z.boolean().optional().describe("Zero data retention."),
  retentionDays: days.optional().describe("Days the provider keeps prompts."),
  region: z.enum(DATA_REGIONS).optional(),
  noTraining: z.boolean().optional().describe("Provider does not train on prompts."),
};
const deployment = z.object({
  providerId: id,
  upstreamModel: name,
  weight: z.number().int().min(1).max(1000).optional(),
});

export const emptyToolInput = z.object({});

export const explainToolInput = z.object({ topic: z.enum(assistantTopics) });

export const openPageToolInput = z.object({ page: z.enum(assistantPages) });

export const apiEndpointsToolInput = z.object({
  scope: z.enum(["all", "v1", "api"]).default("all"),
});

export const codeExampleToolInput = z.object({
  model: name.describe("Public model alias."),
  language: z.enum(["curl", "python", "typescript"]).default("curl"),
  endpoint: z.enum(["chat", "responses", "messages", "embeddings"]).default("chat"),
});

export const usageToolInput = z.object({
  days: z.number().int().min(1).max(366).default(7),
  model: label.optional(),
  teamId: id.optional(),
  orgId: id.optional(),
  projectId: id.optional(),
  memberId: id.optional(),
  keyId: id.optional(),
  userId: id.optional(),
});

export const searchLogsToolInput = z.object({
  model: label.optional().describe("Public model alias."),
  status: z.number().int().optional().describe("HTTP status, for example 502."),
  errorsOnly: z.boolean().optional().describe("Only requests whose outcome is not ok."),
  endpoint: label.optional().describe("Part of the endpoint path, for example /v1/chat/completions."),
  hours: z
    .number()
    .int()
    .min(1)
    .max(744)
    .optional()
    .describe("Look back this many hours when from is not set. Default 24."),
  from: z.string().trim().max(32).optional().describe("ISO 8601 start time."),
  to: z.string().trim().max(32).optional().describe("ISO 8601 end time."),
  limit: z.number().int().min(1).max(50).optional().describe("Requests to list. Default 15."),
});

export const usageBreakdownToolInput = z.object({
  groupBy: z.enum(usageGroups),
  days: z.number().int().min(1).max(366).optional().describe("UTC days including today. Default 7."),
  model: label.optional().describe("Only this public model alias."),
  sort: z.enum(usageSorts).optional(),
  limit: z.number().int().min(1).max(25).optional().describe("Groups to list. Default 10."),
});

export const auditLogToolInput = z.object({
  from: z.string().trim().max(32).optional().describe("ISO date or timestamp."),
  to: z.string().trim().max(32).optional().describe("ISO date or timestamp."),
  limit: z.number().int().min(10).max(50).default(20),
  page: z.number().int().min(1).max(1000).default(1),
});

export const idToolInput = z.object({ id });

export const providerToolInput = z.object({
  id,
  search: label.optional().describe("Filters discovered upstream models by id."),
});

export const createProviderToolInput = z.object({
  kind: name,
  name: label.optional(),
  baseUrl: z.string().trim().max(500).optional(),
  ...providerPolicy,
});

export const updateProviderToolInput = z.object({
  id,
  name: label.optional(),
  baseUrl: z.string().trim().max(500).optional(),
  ...providerPolicy,
});

export const importModelsToolInput = z.object({
  id,
  models: names(200).default([]).describe("Upstream model ids. Empty imports every discovered model."),
  strategy: strategy.optional(),
});

export const confirmIdToolInput = z.object({ id, confirm });

export const aliasToolInput = z.object({ alias: name });

export const createModelToolInput = z.object({
  alias: name,
  providerId: id,
  upstreamModel: name,
  weight: z.number().int().min(1).max(1000).optional(),
  strategy: strategy.optional(),
  numRetries: z.number().int().min(0).max(10).optional(),
  fallbackGroups: names(20).optional(),
  overflowGroup: label.optional(),
});

export const updateModelToolInput = z.object({
  alias: name,
  strategy: strategy.optional(),
  billingMode: z.enum(["routed", "average"]).optional(),
  numRetries: z.number().int().min(0).max(10).optional(),
  fallbackGroups: names(20).optional(),
  overflowGroup: label.optional(),
  addDeployments: z.array(deployment).max(20).optional(),
  removeDeploymentIds: z.array(id).max(50).optional(),
  deploymentWeights: z
    .array(z.object({ id, weight: z.number().int().min(1).max(1000) }))
    .max(50)
    .optional(),
});

export const confirmAliasToolInput = z.object({ alias: name, confirm });

export const saveTemplateToolInput = z.object({
  id: id.optional().describe("Template id to update. Omit to create."),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).optional(),
  models: names(500).optional(),
  patterns: names(50).optional().describe("Alias patterns such as claude-*."),
  providerIds: z.array(id).max(100).optional(),
  regions: z.array(z.enum(DATA_REGIONS)).max(DATA_REGIONS.length).optional(),
  zdrOnly: z.boolean().optional(),
  noTrainingOnly: z.boolean().optional(),
  maxRetentionDays: days.optional(),
});

export const listKeysToolInput = z.object({
  search: label.optional().describe("Matches alias or prefix."),
  limit: z.number().int().min(1).max(100).default(50),
});

export const keyToolInput = z.object({ key: keyRef });

export const createKeyToolInput = z.object({
  alias: z.string().trim().min(1).max(80),
  projectId: id.optional().describe("Project key: the project it belongs to."),
  memberId: id.optional().describe("Personal key: the person it belongs to. Omit both for an internal key."),
  models: names(500).optional(),
  templateIds: z.array(id).max(50).optional(),
  rpm: rpm.optional(),
  tpm: tpm.optional(),
  days: days.optional().describe("Expiry in days. 0 never expires."),
  allowedIps: z.array(z.string().trim().max(64)).max(100).optional(),
  logContent: z.boolean().optional(),
});

export const updateKeyToolInput = z.object({
  key: keyRef,
  alias: z.string().trim().min(1).max(80).optional(),
  projectId: z.string().trim().max(64).optional().describe("Bind to this project. Sending projectId or memberId replaces the binding."),
  memberId: z.string().trim().max(64).optional().describe("Bind to this person. Empty projectId and memberId make an internal key."),
  models: names(500).optional(),
  templateIds: z.array(id).max(50).optional(),
  rpm: rpm.optional(),
  tpm: tpm.optional(),
  allowedIps: z.array(z.string().trim().max(64)).max(100).optional(),
  logContent: z.boolean().optional(),
  blocked: z.boolean().optional(),
});

export const confirmKeyToolInput = z.object({ key: keyRef, confirm });

export const structureToolInput = z.object({
  kind: budgetKind.optional().describe("Only return this kind."),
});

export const saveNodeToolInput = z.object({
  kind: nodeKind.describe("org is a company, team a department, project an application, member a person of the company."),
  id: id.optional().describe("Omit to create."),
  alias: z.string().trim().min(1).max(80).optional().describe("Name. For a member, the person's name."),
  orgId: id.optional().describe("Company of a department, project, or member. Required to create; cannot change later."),
  rpm: rpm.optional().describe("Department RPM limit. 0 is unlimited."),
  tpm: tpm.optional().describe("Department TPM limit. 0 is unlimited."),
  teamId: z.string().trim().max(64).optional().describe("Project or member: department in the same company. Empty string removes it."),
  owner: label.optional().describe("Project owner contact."),
  email: z.string().trim().max(254).optional().describe("Member email, unique within the company."),
  blocked: z.boolean().optional().describe("Member: blocked people cannot use their keys."),
  logContent: z.boolean().optional().describe("Member: store prompts and responses of their keys."),
});

export const deleteNodeToolInput = z.object({ kind: nodeKind, id, confirm });

export const setBudgetToolInput = z.object({
  kind: budgetKind,
  id,
  maxBudget: z.number().min(0).max(1_000_000_000).describe("0 removes the cap."),
  budgetDuration: z
    .string()
    .trim()
    .max(8)
    .default("")
    .describe("Reset period such as 1d, 7d, 30d. Empty never resets."),
});

export const boostToolInput = z.object({
  kind: budgetKind,
  id,
  amount: z.number().positive().max(1_000_000_000),
  hours: z.number().int().min(1).max(720),
});

export const removeBoostToolInput = z.object({ boostId: id });

export const budgetAlertsToolInput = z.object({
  thresholds: z.array(z.number().int().min(1).max(100)).min(1).max(10),
});

export const listUsersToolInput = z.object({
  search: label.optional().describe("Matches username."),
});

export const userBlockedToolInput = z.object({ userId: id, blocked: z.boolean(), confirm });

export const assignRoleToolInput = z.object({
  userId: id,
  roleId: id,
  orgId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe("Company to limit the console user to. Empty string makes a platform user. Omit to keep."),
});

export const confirmUserToolInput = z.object({ userId: id, confirm });

export const testPiiToolInput = z.object({ text: z.string().max(2000) });

export const updateGuardrailsToolInput = z.object({
  scope: z.enum(["global", "org", "key"]).default("global"),
  id: id.optional().describe("Organization or key id for an override."),
  inherit: z.boolean().default(false).describe("Remove the override so the target inherits again."),
  enabled: z.boolean().optional(),
  mode: z.enum(["mask", "block"]).optional(),
  output: z.boolean().optional().describe("Also redact model output."),
  entities: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
});

export const gatewaySettingsToolInput = z.object({
  cacheTtlSeconds: z.number().int().min(0).max(86_400 * 30).optional(),
  logRetentionDays: days.optional(),
  spendRetentionDays: days.optional(),
  auditRetentionDays: days.optional(),
  objectRetentionDays: days.optional(),
  fileRetentionDays: days.optional(),
  contentRetentionDays: days.optional(),
  logContent: z.boolean().optional(),
  logArchive: z.boolean().optional(),
});
