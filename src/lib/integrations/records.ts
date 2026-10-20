import type { Prisma } from "@/generated/prisma/client";
import { slugify } from "@/lib/integrations/sanitize";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/integrations/workflow";
import { executionPolicySchema, policyRuleSchema, workflowGraphSchema } from "@/schemas/integrations";
import type { ZodType } from "zod";
import type {
  AuthMethod,
  EndpointDraft,
  ExecutionPolicy,
  IntegrationStatus,
  IntegrationVisibility,
  PolicyRule,
  PolicyScopeName,
  SideEffect,
  WorkflowGraph,
} from "@/types/integrations";
import { AUTH_METHODS, INTEGRATION_STATUSES, INTEGRATION_VISIBILITIES, POLICY_SCOPES, SIDE_EFFECTS } from "@/types/integrations";

export function fail(code: string): never {
  throw new Error(code);
}

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("VALIDATION");
  return parsed.data;
}

export function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

export function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}

export function statusOf(value: string): IntegrationStatus {
  return oneOf(value, INTEGRATION_STATUSES, "draft");
}

export function visibilityOf(value: string): IntegrationVisibility {
  return oneOf(value, INTEGRATION_VISIBILITIES, "internal");
}

export function effectOf(value: string): SideEffect {
  return oneOf(value, SIDE_EFFECTS, "read");
}

export function authOf(value: string): AuthMethod {
  return oneOf(value, AUTH_METHODS, "none");
}

export function scopeOf(value: string): PolicyScopeName {
  return oneOf(value, POLICY_SCOPES, "tool");
}

export function rulesOf(value: unknown): PolicyRule[] {
  const parsed = policyRuleSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function graphOf(value: unknown): WorkflowGraph {
  const parsed = workflowGraphSchema.safeParse(value);
  if (!parsed.success) fail("VALIDATION");
  return parsed.data;
}

export function graphOrEmpty(value: unknown): WorkflowGraph {
  const parsed = workflowGraphSchema.safeParse(value);
  return parsed.success ? parsed.data : { start: "output", nodes: [{ id: "output", type: "output" }] };
}

export function policyOf(value: unknown): ExecutionPolicy {
  const parsed = executionPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_EXECUTION_POLICY;
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

export function endpointDraft(row: {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  parameters: unknown;
  headers: unknown;
  requestSchema: unknown;
  responseSchema: unknown;
  authRequired: boolean;
  errors: unknown;
  rateLimit: unknown;
  sideEffect: string;
  enabled: boolean;
  origin: string;
  protocolExtras: unknown;
}): EndpointDraft {
  const parameters = Array.isArray(row.parameters) ? (row.parameters as EndpointDraft["parameters"]) : [];
  const headers = row.headers && typeof row.headers === "object" && !Array.isArray(row.headers) ? (row.headers as Record<string, string>) : {};
  const rate = row.rateLimit && typeof row.rateLimit === "object" ? (row.rateLimit as { rpm?: number }) : null;
  return {
    operationId: row.operationId,
    method: row.method,
    path: row.path,
    summary: row.summary,
    parameters,
    headers,
    requestSchema: (row.requestSchema && typeof row.requestSchema === "object" ? row.requestSchema : {}) as EndpointDraft["requestSchema"],
    responseSchema: (row.responseSchema && typeof row.responseSchema === "object" ? row.responseSchema : {}) as EndpointDraft["responseSchema"],
    authRequired: row.authRequired,
    errors: Array.isArray(row.errors) ? (row.errors as EndpointDraft["errors"]) : [],
    rateLimit: rate,
    sideEffect: effectOf(row.sideEffect),
    enabled: row.enabled,
    origin: row.origin === "global" || row.origin === "override" ? row.origin : "local",
    protocolExtras: (row.protocolExtras && typeof row.protocolExtras === "object" ? row.protocolExtras : {}) as Record<string, unknown>,
  };
}

export function endpointData(endpoint: EndpointDraft, origin: EndpointDraft["origin"]): Prisma.EndpointDefinitionCreateManyInput {
  return {
    operationId: endpoint.operationId,
    method: endpoint.method,
    path: endpoint.path,
    summary: endpoint.summary,
    parameters: asJson(endpoint.parameters),
    headers: asJson(endpoint.headers),
    requestSchema: asJson(endpoint.requestSchema),
    responseSchema: asJson(endpoint.responseSchema),
    authRequired: endpoint.authRequired,
    errors: asJson(endpoint.errors),
    rateLimit: endpoint.rateLimit ? asJson(endpoint.rateLimit) : undefined,
    sideEffect: endpoint.sideEffect,
    enabled: false,
    origin,
    protocolExtras: asJson(endpoint.protocolExtras),
  };
}

export function graphMentions(graph: WorkflowGraph, operationId: string): boolean {
  return graph.nodes.some((node) => node.endpointId === operationId || node.operation === operationId);
}

export function strongest(effects: SideEffect[]): SideEffect {
  if (effects.includes("destructive")) return "destructive";
  if (effects.includes("sensitive")) return "sensitive";
  if (effects.includes("write")) return "write";
  return "read";
}

export async function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base);
  if (!(await taken(root))) return root;
  for (let i = 2; i < 50; i += 1) {
    const next = `${root.slice(0, 44)}_${i}`;
    if (!(await taken(next))) return next;
  }
  fail("NAME_EXISTS");
}
