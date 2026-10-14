import { z } from "zod";
import { AUTH_METHODS, INTEGRATION_VISIBILITIES, NODE_TYPES, SIDE_EFFECTS } from "@/types/integrations";

const slug = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/);

const name = z.string().trim().min(1).max(120);
const text = z.string().trim().max(4000);

export const policyRuleSchema = z.object({
  effect: z.enum(["allow", "deny"]),
  tools: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  operations: z.array(z.string().trim().min(1).max(128)).max(200).optional(),
  effects: z.array(z.enum(SIDE_EFFECTS)).max(4).optional(),
  resources: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  parameters: z
    .record(
      z.string().max(64),
      z.object({
        enum: z.array(z.string().max(200)).max(50).optional(),
        pattern: z.string().max(200).optional(),
        maxLength: z.number().int().positive().max(100_000).optional(),
      }),
    )
    .optional(),
  denyFields: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
  quotaRpm: z.number().int().positive().max(100_000).optional(),
  approval: z.boolean().optional(),
  environments: z.array(z.string().trim().min(1).max(32)).max(10).optional(),
  notBefore: z.string().max(40).optional(),
  notAfter: z.string().max(40).optional(),
});

export const workflowNodeSchema = z.object({
  id: z.string().trim().min(1).max(64),
  type: z.enum(NODE_TYPES),
  next: z.string().max(64).optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  operation: z.string().max(128).optional(),
  method: z.string().max(16).optional(),
  path: z.string().max(2000).optional(),
  endpointId: z.string().max(128).optional(),
  body: z.unknown().optional(),
  assignments: z
    .array(
      z.object({
        target: z.string().trim().min(1).max(128),
        from: z.string().max(256).optional(),
        const: z.unknown().optional(),
        template: z.string().max(2000).optional(),
      }),
    )
    .max(40)
    .optional(),
  when: z
    .object({
      path: z.string().min(1).max(256),
      equals: z.unknown().optional(),
      exists: z.boolean().optional(),
    })
    .optional(),
  then: z.string().max(64).optional(),
  else: z.string().max(64).optional(),
  source: z.string().max(256).optional(),
  item: z.string().max(64).optional(),
  steps: z.array(z.string().max(64)).max(20).optional(),
  max: z.number().int().positive().max(20).optional(),
  map: z.record(z.string().max(64), z.string().max(256)).optional(),
  prompt: z.string().max(4000).optional(),
  try: z.string().max(64).optional(),
  fallback: z.unknown().optional(),
  rpm: z.number().int().positive().max(100_000).optional(),
  enabled: z.boolean().optional(),
});

export const workflowGraphSchema = z.object({
  nodes: z.array(workflowNodeSchema).min(1).max(40),
  start: z.string().min(1).max(64),
});

export const executionPolicySchema = z.object({
  timeoutMs: z.number().int().positive().max(60_000),
  maxRetries: z.number().int().min(0).max(2),
  maxResponseBytes: z.number().int().positive().max(1_000_000),
  requiresApproval: z.boolean(),
  environment: z.string().trim().min(1).max(32),
});

export const importSpecSchema = z.object({
  target: z.enum(["blueprint", "company"]),
  id: z.string().trim().min(1).max(64).optional(),
  orgId: z.string().trim().max(64).optional(),
  name: name.optional(),
  visibility: z.enum(INTEGRATION_VISIBILITIES).optional(),
  audience: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  document: z.unknown(),
});

export const manualEndpointSchema = z.object({
  owner: z.enum(["blueprint", "company"]),
  ownerId: z.string().trim().min(1).max(64),
  operationId: slug,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
  path: z.string().trim().min(1).max(2000),
  summary: z.string().trim().max(400).optional(),
  sideEffect: z.enum(SIDE_EFFECTS).optional(),
  enabled: z.boolean().optional(),
});

export const saveToolSchema = z.object({
  id: z.string().trim().max(64).optional(),
  owner: z.enum(["blueprint", "company"]),
  ownerId: z.string().trim().min(1).max(64),
  slug: slug.optional(),
  name: name,
  description: text,
  kind: z.enum(["operation", "workflow"]),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  graph: workflowGraphSchema,
  executionPolicy: executionPolicySchema,
});

export const connectionSchema = z.object({
  id: z.string().trim().max(64).optional(),
  companyIntegrationId: z.string().trim().min(1).max(64),
  name: name,
  authMethod: z.enum(AUTH_METHODS),
  baseUrl: z.string().trim().max(2000),
  internal: z.boolean(),
  secret: z.string().max(8000).optional(),
  label: z.string().trim().max(120).optional(),
  headerName: z.string().trim().max(64).optional(),
  tokenUrl: z.string().trim().max(2000).optional(),
  authorizeUrl: z.string().trim().max(2000).optional(),
  clientId: z.string().trim().max(200).optional(),
  scopes: z.array(z.string().trim().max(80)).max(40).optional(),
});

export const policySaveSchema = z.object({
  id: z.string().trim().max(64).optional(),
  scope: z.enum(["platform", "company", "integration", "connection", "tool", "agent"]),
  orgId: z.string().trim().max(64).optional(),
  blueprintId: z.string().trim().max(64).optional(),
  companyIntegrationId: z.string().trim().max(64).optional(),
  toolId: z.string().trim().max(64).optional(),
  agentId: z.string().trim().max(64).optional(),
  rules: z.array(policyRuleSchema).max(80),
});

export const bindingSchema = z.object({
  id: z.string().trim().max(64).optional(),
  agentId: z.string().trim().min(1).max(64),
  connectionId: z.string().trim().min(1).max(64),
  toolId: z.string().trim().min(1).max(64),
  policyId: z.string().trim().max(64).optional(),
  status: z.enum(["active", "disabled"]),
});

export const agentSchema = z.object({
  id: z.string().trim().max(64).optional(),
  orgId: z.string().trim().min(1).max(64),
  name: name,
  slug: slug.optional(),
  description: text.optional(),
});

export const agentMessageSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  spec: z.string().max(500_000).optional(),
  orgId: z.string().trim().max(64).optional(),
  scope: z.enum(["company", "global"]).optional(),
});

export const approvalDecisionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(1000).optional(),
});

export const publishSchema = z.object({
  toolId: z.string().trim().min(1).max(64),
});

export const oauthCompleteSchema = z.object({
  connectionId: z.string().trim().min(1).max(64),
  code: z.string().trim().min(1).max(4000),
  state: z.string().trim().min(1).max(200),
});

export const blueprintVisibilitySchema = z.object({
  id: z.string().trim().min(1).max(64),
  visibility: z.enum(INTEGRATION_VISIBILITIES),
  audience: z.array(z.string().trim().min(1).max(64)).max(200),
});

export const endpointSelectionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  sideEffect: z.enum(SIDE_EFFECTS).optional(),
});

export const toolTestSchema = z.object({
  toolId: z.string().trim().min(1).max(64),
  connectionId: z.string().trim().min(1).max(64),
  agentId: z.string().trim().min(1).max(64),
  input: z.record(z.string(), z.unknown()),
});

export const rollbackSchema = z.object({
  toolId: z.string().trim().min(1).max(64),
  version: z.number().int().positive(),
});

export const instantiateSchema = z.object({
  blueprintId: z.string().trim().min(1).max(64),
  orgId: z.string().trim().max(64).optional(),
  name: name.optional(),
});

export const companyDraftSchema = z.object({
  orgId: z.string().trim().max(64).optional(),
  name: name,
  description: text.optional(),
});
