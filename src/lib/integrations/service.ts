import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { isPrismaCode } from "@/lib/auth/errors";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf } from "@/lib/auth/scope";
import { planIntegration, type KnownIntegration } from "@/lib/integrations/agent-plan";
import { authHeadersFor, metadataOf, openEnvelope, sealEnvelope } from "@/lib/integrations/credentials";
import { ingestDocument } from "@/lib/integrations/ingest";
import { transition } from "@/lib/integrations/lifecycle";
import { authorizeUrl, exchangeClient, exchangeCode, oauthState, pkcePair, refreshAccess } from "@/lib/integrations/oauth";
import { evaluatePolicy } from "@/lib/integrations/policy";
import { runIntegrationWorkflow } from "@/lib/integrations/runtime";
import { sanitizeForLog, slugify } from "@/lib/integrations/sanitize";
import { blueprintListed, canInstantiate, publicationBlock, publicCredential, sameCompany } from "@/lib/integrations/scope";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { guardedFetch } from "@/lib/mcp/transport";
import { McpError } from "@/lib/mcp/errors";
import {
  agentMessageSchema,
  agentSchema,
  approvalDecisionSchema,
  bindingSchema,
  blueprintVisibilitySchema,
  companyDraftSchema,
  connectionSchema,
  endpointSelectionSchema,
  importSpecSchema,
  instantiateSchema,
  manualEndpointSchema,
  oauthCompleteSchema,
  policySaveSchema,
  publishSchema,
  rollbackSchema,
  saveToolSchema,
  toolTestSchema,
  executionPolicySchema,
  workflowGraphSchema,
  policyRuleSchema,
} from "@/schemas/integrations";
import type { ZodType } from "zod";
import type { AuthenticatedSession } from "@/types/auth";
import type {
  AgentTurn,
  AuthMethod,
  EffectivePreview,
  EndpointDraft,
  ExecutionPolicy,
  ExecutionView,
  IntegrationPage,
  IntegrationStatus,
  IntegrationVisibility,
  PolicyRule,
  PolicyScopeName,
  SideEffect,
  ToolView,
  WorkflowGraph,
} from "@/types/integrations";
import { AUTH_METHODS, INTEGRATION_STATUSES, INTEGRATION_VISIBILITIES, POLICY_SCOPES, SIDE_EFFECTS } from "@/types/integrations";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/integrations/workflow";

function fail(code: string): never {
  throw new Error(code);
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("VALIDATION");
  return parsed.data;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}

function statusOf(value: string): IntegrationStatus {
  return oneOf(value, INTEGRATION_STATUSES, "draft");
}

function visibilityOf(value: string): IntegrationVisibility {
  return oneOf(value, INTEGRATION_VISIBILITIES, "internal");
}

function effectOf(value: string): SideEffect {
  return oneOf(value, SIDE_EFFECTS, "read");
}

function authOf(value: string): AuthMethod {
  return oneOf(value, AUTH_METHODS, "none");
}

function scopeOf(value: string): PolicyScopeName {
  return oneOf(value, POLICY_SCOPES, "tool");
}

function rulesOf(value: unknown): PolicyRule[] {
  const parsed = policyRuleSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function graphOf(value: unknown): WorkflowGraph {
  const parsed = workflowGraphSchema.safeParse(value);
  if (!parsed.success) fail("VALIDATION");
  return parsed.data;
}

function graphOrEmpty(value: unknown): WorkflowGraph {
  const parsed = workflowGraphSchema.safeParse(value);
  return parsed.success ? parsed.data : { start: "output", nodes: [{ id: "output", type: "output" }] };
}

function policyOf(value: unknown): ExecutionPolicy {
  const parsed = executionPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_EXECUTION_POLICY;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function endpointDraft(row: {
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

async function reader(): Promise<AuthenticatedSession> {
  return requirePermission(PERMISSIONS.INTEGRATIONS_READ);
}

async function manager(): Promise<AuthenticatedSession> {
  return requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE);
}

async function publisher(): Promise<AuthenticatedSession> {
  return requirePermission(PERMISSIONS.INTEGRATIONS_PUBLISH);
}

async function credentialUser(): Promise<AuthenticatedSession> {
  return requirePermission(PERMISSIONS.INTEGRATIONS_CREDENTIALS);
}

function assertCompany(session: AuthenticatedSession, orgId: string): void {
  if (!sameCompany(companyOf(session), orgId)) fail("FORBIDDEN");
}

function orgFor(session: AuthenticatedSession, requested?: string): string {
  const company = companyOf(session);
  if (company) {
    if (requested && requested !== company) fail("FORBIDDEN");
    return company;
  }
  if (!requested) fail("ORG_REQUIRED");
  return requested;
}

function assertPlatform(session: AuthenticatedSession): void {
  if (companyOf(session)) fail("PLATFORM_ONLY");
}

async function audit(session: AuthenticatedSession, action: string, objectId: string, after: unknown): Promise<void> {
  await writeAudit({ actor: session.user.id, action, objectType: "integration", objectId, after: sanitizeForLog(after) });
}

export async function loadIntegrationPage(): Promise<IntegrationPage> {
  const session = await reader();
  const company = companyOf(session);
  const [organizations, blueprintRows, integrationRows] = await Promise.all([
    prisma.organization.findMany({ select: { id: true, alias: true }, orderBy: { alias: "asc" } }),
    prisma.integrationBlueprint.findMany({
      include: { audiences: { select: { orgId: true } }, _count: { select: { endpoints: true, tools: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.companyIntegration.findMany({
      where: company ? { orgId: company } : {},
      include: {
        org: { select: { alias: true } },
        blueprint: { select: { name: true } },
        _count: { select: { endpoints: true, tools: true, connections: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
  ]);
  const blueprints = blueprintRows.filter((row) => blueprintListed(visibilityOf(row.visibility), row.audiences.map((item) => item.orgId), company));
  const blueprintIds = blueprints.map((row) => row.id);
  const integrationIds = integrationRows.map((row) => row.id);
  const [endpoints, tools, connections, agents, bindings, policies, approvals, executions] = await Promise.all([
    prisma.endpointDefinition.findMany({
      where: { OR: [{ blueprintId: { in: blueprintIds } }, { companyIntegrationId: { in: integrationIds } }] },
      take: 500,
      orderBy: { operationId: "asc" },
    }),
    prisma.toolDefinition.findMany({
      where: { OR: [{ blueprintId: { in: blueprintIds } }, { companyIntegrationId: { in: integrationIds } }] },
      include: { versions: { orderBy: { version: "desc" as const }, take: 20 } },
      take: 300,
      orderBy: { name: "asc" },
    }),
    prisma.connection.findMany({
      where: { companyIntegrationId: { in: integrationIds } },
      include: { credential: true, companyIntegration: { select: { name: true } } },
      take: 200,
      orderBy: { createdAt: "desc" },
    }),
    prisma.hubAgent.findMany({ where: company ? { orgId: company } : {}, take: 200, orderBy: { name: "asc" } }),
    prisma.agentBinding.findMany({
      where: company ? { orgId: company } : {},
      include: { agent: { select: { name: true } }, connection: { select: { name: true } }, tool: { select: { name: true } } },
      take: 300,
    }),
    prisma.permissionPolicy.findMany({
      where: company ? { OR: [{ orgId: company }, { orgId: null }] } : {},
      take: 200,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.approvalRequest.findMany({
      where: company ? { orgId: company } : {},
      take: 50,
      orderBy: { createdAt: "desc" },
    }),
    prisma.toolExecution.findMany({
      where: company ? { orgId: company } : {},
      take: 50,
      orderBy: { startedAt: "desc" },
    }),
  ]);
  const dayAgo = new Date(Date.now() - 86_400_000);
  const recent = executions.filter((row) => row.startedAt >= dayAgo);
  return {
    canManage: hasPerm(session.permissions, PERMISSIONS.INTEGRATIONS_MANAGE),
    canPublish: hasPerm(session.permissions, PERMISSIONS.INTEGRATIONS_PUBLISH),
    canCredentials: hasPerm(session.permissions, PERMISSIONS.INTEGRATIONS_CREDENTIALS),
    platform: !company,
    orgId: company ?? "",
    companies: organizations.filter((org) => !company || org.id === company).map((org) => ({ id: org.id, alias: org.alias })),
    blueprints: blueprints.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      visibility: visibilityOf(row.visibility),
      protocol: oneOf(row.protocol, ["rest", "graphql", "soap", "grpc", "webhook", "other"] as const, "rest"),
      specKind: oneOf(row.specKind, ["openapi", "postman", "graphql", "manual", "json_schema", "unknown"] as const, "unknown"),
      baseUrl: row.baseUrl,
      status: statusOf(row.status),
      version: row.version,
      authMethods: strings(row.authMethods).map((item) => authOf(item)),
      limitations: strings(row.limitations),
      audience: row.audiences.map((item) => item.orgId),
      endpointCount: row._count.endpoints,
      toolCount: row._count.tools,
    })),
    integrations: integrationRows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      orgAlias: row.org.alias,
      blueprintId: row.blueprintId ?? "",
      blueprintName: row.blueprint?.name ?? "",
      slug: row.slug,
      name: row.name,
      description: row.description,
      status: statusOf(row.status),
      version: row.version,
      endpointCount: row._count.endpoints,
      toolCount: row._count.tools,
      connectionCount: row._count.connections,
    })),
    endpoints: endpoints.map((row) => ({
      id: row.id,
      blueprintId: row.blueprintId ?? "",
      companyIntegrationId: row.companyIntegrationId ?? "",
      ...endpointDraft(row),
    })),
    tools: tools.map((row) => toolView(row)),
    connections: connections.map((row) => {
      const secret = publicCredential({
        sealedSecret: row.credential?.sealedSecret ?? "",
        revokedAt: row.credential?.revokedAt ?? null,
        expiresAt: row.credential?.expiresAt ?? null,
        label: row.credential?.label ?? "",
      });
      return {
        id: row.id,
        orgId: row.orgId,
        companyIntegrationId: row.companyIntegrationId,
        integrationName: row.companyIntegration.name,
        name: row.name,
        authMethod: authOf(row.authMethod),
        baseUrl: row.baseUrl,
        internal: row.internal,
        status: row.status,
        healthError: row.healthError,
        providerScopes: strings(row.providerScopes),
        hasSecret: secret.hasSecret,
        revoked: secret.revoked,
        expiresAt: secret.expiresAt,
        label: secret.label,
      };
    }),
    agents: agents.map((row) => ({ id: row.id, orgId: row.orgId, slug: row.slug, name: row.name, description: row.description })),
    bindings: bindings.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      agentId: row.agentId,
      agentName: row.agent.name,
      connectionId: row.connectionId,
      connectionName: row.connection.name,
      toolId: row.toolId,
      toolName: row.tool.name,
      policyId: row.policyId ?? "",
      status: row.status,
    })),
    policies: policies.map((row) => ({
      id: row.id,
      orgId: row.orgId ?? "",
      scope: scopeOf(row.scope),
      blueprintId: row.blueprintId ?? "",
      companyIntegrationId: row.companyIntegrationId ?? "",
      toolId: row.toolId ?? "",
      agentId: row.agentId ?? "",
      version: row.version,
      rules: rulesOf(row.rules),
    })),
    approvals: approvals.map((row) => ({
      id: row.id,
      orgId: row.orgId ?? "",
      kind: row.kind,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      status: row.status,
      requestedBy: row.requestedBy,
      decidedBy: row.decidedBy,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
    executions: executions.map((row) => executionView(row)),
    stats: {
      published: tools.filter((row) => row.status === "published").length,
      denied: recent.filter((row) => row.decision === "deny" || row.status === "denied").length,
      failed: recent.filter((row) => row.status === "failed").length,
      pendingApprovals: approvals.filter((row) => row.status === "pending").length,
      healthy: connections.filter((row) => row.status === "healthy").length,
    },
  };
}

function toolView(row: {
  id: string;
  blueprintId: string | null;
  companyIntegrationId: string | null;
  slug: string;
  name: string;
  description: string;
  status: string;
  version: number;
  publishedVersion: number;
  kind: string;
  inputSchema: unknown;
  outputSchema: unknown;
  executionPolicy: unknown;
  versions: { graph: unknown; status: string; version: number; publishedAt: Date | null }[];
}): ToolView {
  const latest = row.versions[0];
  return {
    id: row.id,
    blueprintId: row.blueprintId ?? "",
    companyIntegrationId: row.companyIntegrationId ?? "",
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: latest ? statusOf(latest.status) : statusOf(row.status),
    version: row.version,
    publishedVersion: row.publishedVersion,
    kind: row.kind === "workflow" ? "workflow" : "operation",
    inputSchema: (row.inputSchema && typeof row.inputSchema === "object" ? row.inputSchema : {}) as ToolView["inputSchema"],
    outputSchema: (row.outputSchema && typeof row.outputSchema === "object" ? row.outputSchema : {}) as ToolView["outputSchema"],
    executionPolicy: policyOf(row.executionPolicy),
    graph: latest ? graphOrEmpty(latest.graph) : { start: "output", nodes: [{ id: "output", type: "output" }] },
    origin: row.companyIntegrationId ? "company" : "global",
    rollbackVersions: row.versions.filter((version) => version.publishedAt).map((version) => version.version),
  };
}

function executionView(row: {
  id: string;
  orgId: string | null;
  toolId: string;
  toolVersion: number;
  agentId: string;
  actor: string;
  correlationId: string;
  decision: string;
  policyVersion: number;
  status: string;
  operation: string;
  startedAt: Date;
  durationMs: number;
  error: string;
}): ExecutionView {
  return {
    id: row.id,
    orgId: row.orgId ?? "",
    toolId: row.toolId,
    toolVersion: row.toolVersion,
    agentId: row.agentId,
    actor: row.actor,
    correlationId: row.correlationId,
    decision: row.decision,
    policyVersion: row.policyVersion,
    status: row.status,
    operation: row.operation,
    startedAt: row.startedAt.toISOString(),
    durationMs: row.durationMs,
    error: row.error,
  };
}

async function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base);
  if (!(await taken(root))) return root;
  for (let i = 2; i < 50; i += 1) {
    const next = `${root.slice(0, 44)}_${i}`;
    if (!(await taken(next))) return next;
  }
  fail("NAME_EXISTS");
}

export async function importIntegration(raw: unknown): Promise<IntegrationPage> {
  const input = parse(importSpecSchema, raw);
  const ingested = ingestDocument(input.document);
  if (ingested.limitations.includes("document_not_object") || ingested.limitations.includes("document_not_json")) {
    fail("SPEC_INVALID");
  }
  if (input.target === "blueprint") {
    const session = await publisher();
    assertPlatform(session);
    const slug = await uniqueSlug(input.name || ingested.name || "integration", async (value) =>
      Boolean(await prisma.integrationBlueprint.findUnique({ where: { slug: value }, select: { id: true } })),
    );
    const created = await prisma.integrationBlueprint.create({
      data: {
        slug,
        name: input.name || ingested.name || slug,
        description: ingested.description,
        visibility: input.visibility ?? "internal",
        protocol: ingested.protocol,
        specKind: ingested.kind,
        spec: asJson({ kind: ingested.kind }),
        authMethods: asJson(ingested.authMethods),
        limitations: asJson(ingested.limitations),
        baseUrl: ingested.baseUrl,
        status: ingested.endpoints.length ? "configured" : "draft",
        createdById: session.user.id,
        endpoints: { create: ingested.endpoints.map((endpoint) => endpointData(endpoint, "global")) },
      },
    });
    if (input.audience?.length && (input.visibility ?? "internal") === "selected") {
      await prisma.integrationAudience.createMany({
        data: input.audience.map((orgId) => ({ blueprintId: created.id, orgId })),
      });
    }
    await audit(session, "integration.blueprint_import", created.id, { slug, limitations: ingested.limitations });
    return loadIntegrationPage();
  }
  const session = await manager();
  const orgId = orgFor(session, input.orgId);
  const slug = await uniqueSlug(input.name || ingested.name || "integration", async (value) =>
    Boolean(await prisma.companyIntegration.findUnique({ where: { orgId_slug: { orgId, slug: value } }, select: { id: true } })),
  );
  const created = await prisma.companyIntegration.create({
    data: {
      orgId,
      slug,
      name: input.name || ingested.name || slug,
      description: ingested.description,
      status: ingested.endpoints.length ? "configured" : "draft",
      createdById: session.user.id,
      endpoints: { create: ingested.endpoints.map((endpoint) => endpointData(endpoint, "local")) },
    },
  });
  await audit(session, "integration.company_import", created.id, { orgId, slug, limitations: ingested.limitations });
  return loadIntegrationPage();
}

function endpointData(endpoint: EndpointDraft, origin: EndpointDraft["origin"]): Prisma.EndpointDefinitionCreateManyInput {
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

export async function setBlueprintVisibility(raw: unknown): Promise<IntegrationPage> {
  const session = await publisher();
  assertPlatform(session);
  const input = parse(blueprintVisibilitySchema, raw);
  const before = await prisma.integrationBlueprint.findUnique({ where: { id: input.id }, select: { id: true } });
  if (!before) fail("INTEGRATION_NOT_FOUND");
  await prisma.integrationAudience.deleteMany({ where: { blueprintId: input.id } });
  await prisma.integrationBlueprint.update({ where: { id: input.id }, data: { visibility: input.visibility } });
  if (input.visibility === "selected" && input.audience.length) {
    await prisma.integrationAudience.createMany({ data: input.audience.map((orgId) => ({ blueprintId: input.id, orgId })) });
  }
  await audit(session, "integration.visibility", input.id, { visibility: input.visibility, audience: input.audience });
  return loadIntegrationPage();
}

export async function createCompanyDraft(raw: unknown): Promise<IntegrationPage> {
  const session = await manager();
  const input = parse(companyDraftSchema, raw);
  const orgId = orgFor(session, input.orgId);
  const slug = await uniqueSlug(input.name, async (value) =>
    Boolean(await prisma.companyIntegration.findUnique({ where: { orgId_slug: { orgId, slug: value } }, select: { id: true } })),
  );
  const created = await prisma.companyIntegration.create({
    data: { orgId, slug, name: input.name, description: input.description ?? "", createdById: session.user.id },
  });
  await audit(session, "integration.company_create", created.id, { orgId, slug });
  return loadIntegrationPage();
}

export async function instantiateBlueprint(raw: unknown): Promise<IntegrationPage> {
  const session = await manager();
  const input = parse(instantiateSchema, raw);
  const orgId = orgFor(session, input.orgId);
  const blueprint = await prisma.integrationBlueprint.findUnique({
    where: { id: input.blueprintId },
    include: { audiences: true, endpoints: true, tools: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } } },
  });
  if (!blueprint) fail("INTEGRATION_NOT_FOUND");
  if (!canInstantiate(visibilityOf(blueprint.visibility), blueprint.audiences.map((item) => item.orgId), orgId)) {
    fail("FORBIDDEN");
  }
  const slug = await uniqueSlug(input.name || blueprint.slug, async (value) =>
    Boolean(await prisma.companyIntegration.findUnique({ where: { orgId_slug: { orgId, slug: value } }, select: { id: true } })),
  );
  const created = await prisma.companyIntegration.create({
    data: {
      orgId,
      blueprintId: blueprint.id,
      slug,
      name: input.name || blueprint.name,
      description: blueprint.description,
      status: "configured",
      createdById: session.user.id,
      endpoints: { create: blueprint.endpoints.map((row) => endpointData({ ...endpointDraft(row), origin: "global" }, "global")) },
    },
  });
  for (const tool of blueprint.tools) {
    const version = tool.versions[0];
    if (!version) continue;
    const toolSlug = await uniqueSlug(tool.slug, async (value) =>
      Boolean(await prisma.toolDefinition.findFirst({ where: { companyIntegrationId: created.id, slug: value }, select: { id: true } })),
    );
    await prisma.toolDefinition.create({
      data: {
        companyIntegrationId: created.id,
        slug: toolSlug,
        name: tool.name,
        description: tool.description,
        inputSchema: asJson(tool.inputSchema),
        outputSchema: asJson(tool.outputSchema),
        status: "configured",
        kind: tool.kind,
        executionPolicy: asJson(tool.executionPolicy),
        createdById: session.user.id,
        versions: {
          create: {
            version: 1,
            status: "configured",
            graph: asJson(version.graph),
            inputSchema: asJson(version.inputSchema),
            outputSchema: asJson(version.outputSchema),
            policySnapshot: asJson(version.policySnapshot),
            createdById: session.user.id,
          },
        },
      },
    });
  }
  await audit(session, "integration.instantiate", created.id, { orgId, blueprintId: blueprint.id });
  return loadIntegrationPage();
}

export async function addManualEndpoint(raw: unknown): Promise<IntegrationPage> {
  const session = await manager();
  const input = parse(manualEndpointSchema, raw);
  await assertOwner(session, input.owner, input.ownerId);
  const draft: EndpointDraft = {
    operationId: input.operationId,
    method: input.method,
    path: input.path,
    summary: input.summary ?? "",
    parameters: [],
    headers: {},
    requestSchema: {},
    responseSchema: {},
    authRequired: true,
    errors: [],
    rateLimit: null,
    sideEffect: input.sideEffect ?? (input.method === "GET" || input.method === "HEAD" ? "read" : "write"),
    enabled: input.enabled ?? false,
    origin: input.owner === "blueprint" ? "global" : "local",
    protocolExtras: {},
  };
  await prisma.endpointDefinition.create({
    data: {
      ...endpointData(draft, draft.origin),
      ...(input.owner === "blueprint" ? { blueprintId: input.ownerId } : { companyIntegrationId: input.ownerId }),
    },
  });
  await audit(session, "integration.endpoint_add", input.ownerId, { operationId: input.operationId });
  return loadIntegrationPage();
}

async function assertOwner(session: AuthenticatedSession, owner: "blueprint" | "company", ownerId: string): Promise<void> {
  if (owner === "blueprint") {
    assertPlatform(session);
    if (!hasPerm(session.permissions, PERMISSIONS.INTEGRATIONS_PUBLISH)) fail("FORBIDDEN");
    const row = await prisma.integrationBlueprint.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!row) fail("INTEGRATION_NOT_FOUND");
    return;
  }
  const row = await prisma.companyIntegration.findUnique({ where: { id: ownerId }, select: { orgId: true } });
  if (!row) fail("INTEGRATION_NOT_FOUND");
  assertCompany(session, row.orgId);
}

export async function setEndpointSelection(raw: unknown): Promise<IntegrationPage> {
  const session = await manager();
  const input = parse(endpointSelectionSchema, raw);
  const row = await prisma.endpointDefinition.findUnique({
    where: { id: input.id },
    include: { blueprint: { select: { id: true } }, companyIntegration: { select: { orgId: true } } },
  });
  if (!row) fail("INTEGRATION_NOT_FOUND");
  if (row.companyIntegration) assertCompany(session, row.companyIntegration.orgId);
  else {
    assertPlatform(session);
    if (!hasPerm(session.permissions, PERMISSIONS.INTEGRATIONS_PUBLISH)) fail("FORBIDDEN");
  }
  await prisma.endpointDefinition.update({
    data: {
      enabled: input.enabled,
      ...(input.sideEffect ? { sideEffect: input.sideEffect } : {}),
      ...(row.companyIntegration && row.origin === "global" ? { origin: "override" } : {}),
    },
    where: { id: row.id },
  });
  return loadIntegrationPage();
}

export async function saveIntegrationTool(raw: unknown): Promise<IntegrationPage> {
  const session = await manager();
  const input = parse(saveToolSchema, raw);
  await assertOwner(session, input.owner, input.ownerId);
  const slug = input.slug || slugify(input.name);
  if (input.id) {
    const existing = await prisma.toolDefinition.findUnique({ where: { id: input.id } });
    if (!existing) fail("INTEGRATION_NOT_FOUND");
    if (existing.companyIntegrationId) {
      const parent = await prisma.companyIntegration.findUnique({ where: { id: existing.companyIntegrationId }, select: { orgId: true } });
      if (!parent) fail("INTEGRATION_NOT_FOUND");
      assertCompany(session, parent.orgId);
    } else assertPlatform(session);
    const next = existing.version + 1;
    const live = existing.publishedVersion > 0;
    await prisma.toolDefinition.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        description: input.description,
        slug,
        kind: input.kind,
        inputSchema: asJson(input.inputSchema),
        outputSchema: asJson(input.outputSchema),
        executionPolicy: asJson(input.executionPolicy),
        version: next,
        status: live ? existing.status : "configured",
        versions: {
          create: {
            version: next,
            status: "configured",
            graph: asJson(input.graph),
            inputSchema: asJson(input.inputSchema),
            outputSchema: asJson(input.outputSchema),
            policySnapshot: asJson(input.executionPolicy),
            createdById: session.user.id,
          },
        },
      },
    });
    await audit(session, "integration.tool_save", existing.id, { version: next, publishedVersion: existing.publishedVersion });
    return loadIntegrationPage();
  }
  try {
    const created = await prisma.toolDefinition.create({
      data: {
        ...(input.owner === "blueprint" ? { blueprintId: input.ownerId } : { companyIntegrationId: input.ownerId }),
        slug,
        name: input.name,
        description: input.description,
        kind: input.kind,
        inputSchema: asJson(input.inputSchema),
        outputSchema: asJson(input.outputSchema),
        executionPolicy: asJson(input.executionPolicy),
        status: "configured",
        createdById: session.user.id,
        versions: {
          create: {
            version: 1,
            status: "configured",
            graph: asJson(input.graph),
            inputSchema: asJson(input.inputSchema),
            outputSchema: asJson(input.outputSchema),
            policySnapshot: asJson(input.executionPolicy),
            createdById: session.user.id,
          },
        },
      },
    });
    await audit(session, "integration.tool_create", created.id, { slug });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) fail("NAME_EXISTS");
    throw err;
  }
  return loadIntegrationPage();
}

async function latestVersion(toolId: string) {
  const version = await prisma.toolVersion.findFirst({ where: { toolId }, orderBy: { version: "desc" } });
  if (!version) fail("INTEGRATION_NOT_FOUND");
  return version;
}

function permissionHolds(endpoints: readonly EndpointDraft[], rules: readonly PolicyRule[]): boolean {
  if (!rules.length) return false;
  return endpoints.every((endpoint) => {
    const decision = evaluatePolicy(rules, {
      tool: endpoint.operationId,
      operation: endpoint.operationId,
      sideEffect: endpoint.sideEffect,
      resource: endpoint.path,
      parameters: {},
      environment: "production",
      now: new Date(),
    });
    if (endpoint.sideEffect === "destructive" || endpoint.sideEffect === "sensitive") {
      return decision.decision === "deny" || decision.approval;
    }
    return decision.decision === "allow" || decision.decision === "deny";
  });
}

export async function validateTool(raw: unknown): Promise<IntegrationPage> {
  const session = await manager();
  const input = parse(publishSchema, raw);
  const tool = await prisma.toolDefinition.findUnique({ where: { id: input.toolId }, include: { companyIntegration: true, blueprint: true } });
  if (!tool) fail("INTEGRATION_NOT_FOUND");
  if (tool.companyIntegration) assertCompany(session, tool.companyIntegration.orgId);
  else assertPlatform(session);
  const version = await latestVersion(tool.id);
  const endpoints = await endpointsOf(tool.blueprintId, tool.companyIntegrationId);
  const rules = await rulesTouching(tool.id, tool.companyIntegration?.orgId ?? null, tool.blueprintId);
  const ok = permissionHolds(endpoints.filter((endpoint) => endpoint.enabled || graphMentions(graphOf(version.graph), endpoint.operationId)), rules);
  const schemaOk = Boolean(version.inputSchema && version.outputSchema && version.graph);
  if (!schemaOk || !ok) fail("POLICY_DENIED");
  const next = transition(statusOf(version.status), "validate_ok");
  if (!next) fail("LIFECYCLE_BLOCKED");
  await prisma.toolVersion.update({ where: { id: version.id }, data: { status: next, notes: JSON.stringify({ permission: true, schema: true, configuration: true }) } });
  if (tool.publishedVersion === 0) await prisma.toolDefinition.update({ where: { id: tool.id }, data: { status: next } });
  await audit(session, "integration.tool_validate", tool.id, { version: version.version, status: next });
  return loadIntegrationPage();
}

function graphMentions(graph: WorkflowGraph, operationId: string): boolean {
  return graph.nodes.some((node) => node.endpointId === operationId || node.operation === operationId);
}

async function endpointsOf(blueprintId: string | null, companyIntegrationId: string | null): Promise<EndpointDraft[]> {
  const rows = await prisma.endpointDefinition.findMany({
    where: companyIntegrationId ? { companyIntegrationId } : { blueprintId: blueprintId ?? "" },
  });
  return rows.map((row) => endpointDraft(row));
}

async function rulesTouching(toolId: string, orgId: string | null, blueprintId: string | null): Promise<PolicyRule[]> {
  const rows = await prisma.permissionPolicy.findMany({
    where: {
      OR: [
        { toolId },
        { scope: "platform" },
        ...(orgId ? [{ orgId, scope: "company" }] : []),
        ...(blueprintId ? [{ blueprintId }] : []),
      ],
    },
  });
  return rows.flatMap((row) => rulesOf(row.rules));
}

export async function requestToolApproval(raw: unknown): Promise<IntegrationPage> {
  const session = await publisher();
  const input = parse(publishSchema, raw);
  const tool = await ownedTool(session, input.toolId);
  const version = await latestVersion(tool.id);
  if (statusOf(version.status) !== "validated") fail("LIFECYCLE_BLOCKED");
  await prisma.approvalRequest.create({
    data: {
      orgId: tool.companyIntegration?.orgId,
      kind: "publish",
      subjectType: "tool",
      subjectId: tool.id,
      requestedBy: session.user.id,
      snapshot: asJson({ version: version.version, policy: version.policySnapshot }),
    },
  });
  await audit(session, "integration.approval_request", tool.id, { version: version.version });
  return loadIntegrationPage();
}

async function ownedTool(session: AuthenticatedSession, toolId: string) {
  const tool = await prisma.toolDefinition.findUnique({ where: { id: toolId }, include: { companyIntegration: true } });
  if (!tool) fail("INTEGRATION_NOT_FOUND");
  if (tool.companyIntegration) assertCompany(session, tool.companyIntegration.orgId);
  else assertPlatform(session);
  return tool;
}

export async function decideApproval(raw: unknown): Promise<IntegrationPage> {
  const session = await publisher();
  const input = parse(approvalDecisionSchema, raw);
  const row = await prisma.approvalRequest.findUnique({ where: { id: input.id } });
  if (!row || row.status !== "pending") fail("NOT_FOUND");
  if (row.orgId) assertCompany(session, row.orgId);
  else assertPlatform(session);
  if (row.requestedBy === session.user.id) fail("FORBIDDEN");
  await prisma.approvalRequest.update({
    where: { id: row.id },
    data: { status: input.decision, decidedBy: session.user.id, decidedAt: new Date(), reason: input.reason ?? "" },
  });
  if (row.subjectType === "tool") {
    const version = await latestVersion(row.subjectId);
    const event = input.decision === "approved" ? "approve" : "reject";
    const next = transition(statusOf(version.status), event);
    if (next) {
      await prisma.toolVersion.update({ where: { id: version.id }, data: { status: next } });
      const tool = await prisma.toolDefinition.findUnique({ where: { id: row.subjectId }, select: { publishedVersion: true } });
      if (tool && tool.publishedVersion === 0) await prisma.toolDefinition.update({ where: { id: row.subjectId }, data: { status: next } });
    }
  }
  await audit(session, "integration.approval_decide", row.id, { decision: input.decision, subjectId: row.subjectId });
  return loadIntegrationPage();
}

export async function publishTool(raw: unknown): Promise<IntegrationPage> {
  const session = await publisher();
  const input = parse(publishSchema, raw);
  const tool = await ownedTool(session, input.toolId);
  const version = await latestVersion(tool.id);
  const execution = policyOf(version.policySnapshot);
  const approved = Boolean(
    await prisma.approvalRequest.findFirst({
      where: { subjectType: "tool", subjectId: tool.id, status: "approved" },
      select: { id: true },
    }),
  );
  const endpoints = await endpointsOf(tool.blueprintId, tool.companyIntegrationId);
  const rules = await rulesTouching(tool.id, tool.companyIntegration?.orgId ?? null, tool.blueprintId);
  const mentioned = endpoints.filter((endpoint) => graphMentions(graphOf(version.graph), endpoint.operationId));
  const block = publicationBlock({
    status: statusOf(version.status),
    approvalRequired: execution.requiresApproval,
    approved,
    checks: {
      configuration: version.graph != null,
      schema: version.inputSchema != null && version.outputSchema != null,
      permission: permissionHolds(mentioned.length ? mentioned : endpoints, rules),
    },
    actor: "user",
  });
  if (block === "approval_required") fail("APPROVAL_REQUIRED");
  if (block) fail("LIFECYCLE_BLOCKED");
  const next = transition(statusOf(version.status), "publish", { approvalRequired: execution.requiresApproval, approved });
  if (!next) fail("LIFECYCLE_BLOCKED");
  await prisma.toolVersion.update({ where: { id: version.id }, data: { status: "published", publishedAt: new Date() } });
  await prisma.toolDefinition.update({
    where: { id: tool.id },
    data: { status: "published", publishedVersion: version.version, version: version.version },
  });
  await audit(session, "integration.tool_publish", tool.id, { version: version.version });
  return loadIntegrationPage();
}

export async function deprecateTool(raw: unknown): Promise<IntegrationPage> {
  const session = await publisher();
  const input = parse(publishSchema, raw);
  const tool = await ownedTool(session, input.toolId);
  const next = transition(statusOf(tool.status), "deprecate");
  if (!next) fail("LIFECYCLE_BLOCKED");
  await prisma.toolDefinition.update({ where: { id: tool.id }, data: { status: next } });
  await audit(session, "integration.tool_deprecate", tool.id, { status: next });
  return loadIntegrationPage();
}

export async function rollbackTool(raw: unknown): Promise<IntegrationPage> {
  const session = await publisher();
  const input = parse(rollbackSchema, raw);
  const tool = await ownedTool(session, input.toolId);
  const version = await prisma.toolVersion.findUnique({ where: { toolId_version: { toolId: tool.id, version: input.version } } });
  if (!version?.publishedAt) fail("LIFECYCLE_BLOCKED");
  await prisma.toolDefinition.update({
    where: { id: tool.id },
    data: {
      publishedVersion: version.version,
      status: "published",
      inputSchema: asJson(version.inputSchema),
      outputSchema: asJson(version.outputSchema),
      executionPolicy: asJson(version.policySnapshot),
    },
  });
  await audit(session, "integration.tool_rollback", tool.id, { version: version.version });
  return loadIntegrationPage();
}

export async function saveConnection(raw: unknown): Promise<IntegrationPage> {
  const session = await credentialUser();
  const input = parse(connectionSchema, raw);
  const integration = await prisma.companyIntegration.findUnique({
    where: { id: input.companyIntegrationId },
    include: { blueprint: { select: { baseUrl: true } } },
  });
  if (!integration) fail("INTEGRATION_NOT_FOUND");
  assertCompany(session, integration.orgId);
  if (input.internal && companyOf(session)) fail("PLATFORM_ONLY");
  const baseUrl = input.baseUrl || integration.blueprint?.baseUrl || "";
  if (baseUrl) {
    const verdict = checkServerUrl(baseUrl, input.internal);
    if (!verdict.ok) fail(verdict.code);
  }
  const metadata = {
    headerName: input.headerName,
    tokenUrl: input.tokenUrl,
    authorizeUrl: input.authorizeUrl,
    clientId: input.clientId,
    scopes: input.scopes ?? [],
  };
  const envelope = input.secret
    ? input.authMethod === "basic"
      ? { apiKey: input.secret }
      : input.authMethod === "oauth2"
        ? { clientSecret: input.secret }
        : { apiKey: input.secret, accessToken: input.authMethod === "bearer" || input.authMethod === "service_account" ? input.secret : undefined }
    : null;
  const secretData = envelope ? sealEnvelope(envelope) : undefined;
  if (input.authMethod !== "none" && !secretData && !input.id) fail("CREDENTIAL_REQUIRED");
  const data = {
    name: input.name,
    authMethod: input.authMethod,
    baseUrl,
    internal: input.internal,
    status: secretData || input.authMethod === "none" ? "configured" : "unconfigured",
    providerScopes: asJson(input.scopes ?? []),
  };
  const connection = input.id
    ? await prisma.connection.update({ where: { id: input.id }, data })
    : await prisma.connection.create({
        data: { ...data, orgId: integration.orgId, companyIntegrationId: integration.id, createdById: session.user.id },
      });
  if (connection.orgId !== integration.orgId) fail("FORBIDDEN");
  if (secretData) {
    await prisma.credentialReference.upsert({
      where: { connectionId: connection.id },
      create: {
        orgId: integration.orgId,
        connectionId: connection.id,
        kind: input.authMethod,
        label: input.label ?? "",
        sealedSecret: secretData,
        metadata: asJson(metadata),
      },
      update: { sealedSecret: secretData, label: input.label ?? "", kind: input.authMethod, metadata: asJson(metadata), revokedAt: null, rotatedAt: new Date() },
    });
  }
  await audit(session, "integration.connection_save", connection.id, { authMethod: input.authMethod, hasSecret: Boolean(secretData) });
  return loadIntegrationPage();
}

export async function beginOauth(connectionId: string): Promise<{ authorizeUrl: string; state: string; page: IntegrationPage }> {
  const session = await credentialUser();
  const connection = await prisma.connection.findUnique({ where: { id: connectionId }, include: { credential: true } });
  if (!connection) fail("INTEGRATION_NOT_FOUND");
  assertCompany(session, connection.orgId);
  const metadata = metadataOf(connection.credential?.metadata);
  if (!metadata.authorizeUrl || !metadata.clientId) fail("CREDENTIAL_REQUIRED");
  const pair = pkcePair();
  const state = oauthState();
  const current = openEnvelope(connection.credential?.sealedSecret ?? "");
  const sealed = sealEnvelope({ ...current, verifier: pair.verifier });
  await prisma.credentialReference.upsert({
    where: { connectionId: connection.id },
    create: {
      orgId: connection.orgId,
      connectionId: connection.id,
      kind: "oauth2",
      sealedSecret: sealed,
      metadata: asJson({ ...metadata, state }),
    },
    update: { sealedSecret: sealed, metadata: asJson({ ...metadata, state }) },
  });
  return {
    authorizeUrl: authorizeUrl({
      authorizeUrl: metadata.authorizeUrl,
      clientId: metadata.clientId,
      scopes: metadata.scopes ?? [],
      state,
      challenge: pair.challenge,
    }),
    state,
    page: await loadIntegrationPage(),
  };
}

export async function completeOauth(raw: unknown): Promise<IntegrationPage> {
  const session = await credentialUser();
  const input = parse(oauthCompleteSchema, raw);
  const connection = await prisma.connection.findUnique({ where: { id: input.connectionId }, include: { credential: true } });
  if (!connection?.credential) fail("CREDENTIAL_REQUIRED");
  assertCompany(session, connection.orgId);
  const metadata = metadataOf(connection.credential.metadata);
  if (!metadata.state || metadata.state !== input.state || !metadata.tokenUrl || !metadata.clientId) fail("VALIDATION");
  const current = openEnvelope(connection.credential.sealedSecret);
  if (!current.verifier) fail("CREDENTIAL_REQUIRED");
  const fetched = await exchangeCode(
    {
      tokenUrl: metadata.tokenUrl,
      clientId: metadata.clientId,
      clientSecret: current.clientSecret,
      code: input.code,
      verifier: current.verifier,
    },
    tokenFetch(connection.internal),
  );
  await prisma.credentialReference.update({
    where: { connectionId: connection.id },
    data: {
      sealedSecret: sealEnvelope({ ...current, ...fetched.envelope, verifier: undefined }),
      expiresAt: fetched.expiresAt ? new Date(fetched.expiresAt) : null,
      metadata: asJson({ ...metadata, state: "" }),
    },
  });
  await prisma.connection.update({
    where: { id: connection.id },
    data: { status: "configured", providerScopes: asJson(fetched.scopes.length ? fetched.scopes : strings(connection.providerScopes)) },
  });
  await audit(session, "integration.oauth_complete", connection.id, { hasSecret: true });
  return loadIntegrationPage();
}

function tokenFetch(internal: boolean) {
  const send = guardedFetch(internal);
  return async (input: { url: string; method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => {
    const verdict = checkServerUrl(input.url, internal);
    if (!verdict.ok) fail(verdict.code);
    const response = await send(input.url, { method: input.method, headers: input.headers, body: input.body, signal: input.signal });
    return { status: response.status, body: await response.text() };
  };
}

export async function checkConnection(connectionId: string): Promise<IntegrationPage> {
  const session = await credentialUser();
  const connection = await prisma.connection.findUnique({ where: { id: connectionId } });
  if (!connection) fail("INTEGRATION_NOT_FOUND");
  assertCompany(session, connection.orgId);
  let status = "unconfigured";
  let healthError: string;
  if (!connection.baseUrl) healthError = "MCP_URL_INVALID";
  else {
    try {
      const response = await guardedFetch(connection.internal)(connection.baseUrl, { method: "GET", headers: {}, signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel();
      status = response.status >= 200 && response.status < 300 ? "healthy" : "error";
      healthError = status === "healthy" ? "" : `http_${response.status}`;
    } catch (err) {
      status = "error";
      healthError = err instanceof McpError ? err.code : "MCP_UNREACHABLE";
    }
  }
  await prisma.connection.update({
    where: { id: connection.id },
    data: { status, healthError, healthCheckedAt: new Date() },
  });
  await audit(session, "integration.connection_health", connection.id, { status, healthError });
  return loadIntegrationPage();
}

export async function revokeCredential(connectionId: string): Promise<IntegrationPage> {
  const session = await credentialUser();
  const connection = await prisma.connection.findUnique({ where: { id: connectionId }, include: { credential: true } });
  if (!connection?.credential) fail("CREDENTIAL_REQUIRED");
  assertCompany(session, connection.orgId);
  await prisma.credentialReference.update({
    where: { id: connection.credential.id },
    data: { sealedSecret: "", revokedAt: new Date() },
  });
  await prisma.connection.update({ where: { id: connection.id }, data: { status: "revoked" } });
  await audit(session, "integration.credential_revoke", connection.id, { revoked: true });
  return loadIntegrationPage();
}

export async function savePolicy(raw: unknown): Promise<IntegrationPage> {
  const session = await publisher();
  const input = parse(policySaveSchema, raw);
  if (input.scope === "platform") assertPlatform(session);
  const orgId = input.orgId || companyOf(session) || null;
  if (orgId) assertCompany(session, orgId);
  if (input.companyIntegrationId) {
    const row = await prisma.companyIntegration.findUnique({ where: { id: input.companyIntegrationId }, select: { orgId: true } });
    if (!row) fail("INTEGRATION_NOT_FOUND");
    assertCompany(session, row.orgId);
  }
  const data = {
    scope: input.scope,
    orgId: input.scope === "platform" ? null : orgId,
    blueprintId: input.blueprintId || null,
    companyIntegrationId: input.companyIntegrationId || null,
    toolId: input.toolId || null,
    agentId: input.agentId || null,
    rules: asJson(input.rules),
  };
  const saved = input.id
    ? await prisma.permissionPolicy.update({ where: { id: input.id }, data: { ...data, version: { increment: 1 } } })
    : await prisma.permissionPolicy.create({ data });
  await audit(session, "integration.policy_save", saved.id, { scope: input.scope, rules: input.rules.length });
  return loadIntegrationPage();
}

export async function saveAgent(raw: unknown): Promise<IntegrationPage> {
  const session = await manager();
  const input = parse(agentSchema, raw);
  const orgId = orgFor(session, input.orgId);
  const slug = input.slug || slugify(input.name);
  if (input.id) {
    const existing = await prisma.hubAgent.findUnique({ where: { id: input.id }, select: { orgId: true } });
    if (!existing) fail("INTEGRATION_NOT_FOUND");
    assertCompany(session, existing.orgId);
    if (existing.orgId !== orgId) fail("FORBIDDEN");
  }
  try {
    const saved = input.id
      ? await prisma.hubAgent.update({ where: { id: input.id }, data: { name: input.name, slug, description: input.description ?? "" } })
      : await prisma.hubAgent.create({ data: { orgId, slug, name: input.name, description: input.description ?? "", createdById: session.user.id } });
    if (saved.orgId !== orgId) fail("FORBIDDEN");
    await audit(session, "integration.agent_save", saved.id, { orgId, slug });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) fail("NAME_EXISTS");
    throw err;
  }
  return loadIntegrationPage();
}

export async function saveBinding(raw: unknown): Promise<IntegrationPage> {
  const session = await publisher();
  const input = parse(bindingSchema, raw);
  const [agent, connection, tool] = await Promise.all([
    prisma.hubAgent.findUnique({ where: { id: input.agentId } }),
    prisma.connection.findUnique({ where: { id: input.connectionId } }),
    prisma.toolDefinition.findUnique({ where: { id: input.toolId } }),
  ]);
  if (!agent || !connection || !tool) fail("INTEGRATION_NOT_FOUND");
  if (agent.orgId !== connection.orgId) fail("FORBIDDEN");
  assertCompany(session, agent.orgId);
  if (tool.status !== "published" && tool.publishedVersion === 0) fail("TOOL_NOT_PUBLISHED");
  if (tool.companyIntegrationId && tool.companyIntegrationId !== connection.companyIntegrationId) fail("FORBIDDEN");
  const saved = await prisma.agentBinding.upsert({
    where: { agentId_connectionId_toolId: { agentId: agent.id, connectionId: connection.id, toolId: tool.id } },
    create: {
      orgId: agent.orgId,
      agentId: agent.id,
      connectionId: connection.id,
      toolId: tool.id,
      policyId: input.policyId || null,
      status: input.status,
    },
    update: { policyId: input.policyId || null, status: input.status },
  });
  await audit(session, "integration.binding_save", saved.id, { agentId: agent.id, toolId: tool.id, status: input.status });
  return loadIntegrationPage();
}

export async function previewAccess(agentId: string, toolId: string): Promise<EffectivePreview> {
  const session = await reader();
  const agent = await prisma.hubAgent.findUnique({ where: { id: agentId } });
  const tool = await prisma.toolDefinition.findUnique({ where: { id: toolId }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!agent || !tool) fail("INTEGRATION_NOT_FOUND");
  assertCompany(session, agent.orgId);
  const layers = await prisma.permissionPolicy.findMany({
    where: { OR: [{ agentId: agent.id }, { toolId: tool.id }, { orgId: agent.orgId }, { scope: "platform" }] },
  });
  const rules = layers.flatMap((layer) => rulesOf(layer.rules));
  const version = tool.versions[0];
  const graph = version ? graphOf(version.graph) : { start: "", nodes: [] };
  const operation = graph.nodes.find((node) => node.type === "request")?.endpointId || tool.slug;
  const endpoints = await endpointsOf(tool.blueprintId, tool.companyIntegrationId);
  const mentioned = endpoints.filter((endpoint) => graphMentions(graph, endpoint.operationId));
  const decision = evaluatePolicy(rules, {
    tool: tool.slug,
    operation,
    sideEffect: strongest(mentioned.map((endpoint) => endpoint.sideEffect)),
    resource: operation,
    parameters: {},
    environment: policyOf(tool.executionPolicy).environment,
    now: new Date(),
  });
  return {
    agentId,
    toolId,
    decision,
    providerNote: "LLMHUB can only narrow the provider credential. It cannot grant an operation the external identity cannot perform.",
    layers: layers.map((layer) => ({ name: layer.scope, version: layer.version, rules: rulesOf(layer.rules).length })),
  };
}

export async function askIntegrationAgent(raw: unknown): Promise<{ turn: AgentTurn; page: IntegrationPage }> {
  const input = parse(agentMessageSchema, raw);
  const session = input.scope === "global" ? await publisher() : await manager();
  if (input.scope === "global") assertPlatform(session);
  const orgId = input.scope === "global" ? null : orgFor(session, input.orgId);
  const [blueprints, integrations] = await Promise.all([
    prisma.integrationBlueprint.findMany({ select: { id: true, name: true, slug: true, visibility: true }, take: 100 }),
    orgId
      ? prisma.companyIntegration.findMany({ where: { orgId }, select: { id: true, name: true, slug: true }, take: 100 })
      : Promise.resolve([]),
  ]);
  const existing: KnownIntegration[] = [
    ...blueprints.map((row) => ({ id: row.id, name: row.name, slug: row.slug, scope: "global" as const })),
    ...integrations.map((row) => ({ id: row.id, name: row.name, slug: row.slug, scope: "company" as const })),
  ];
  const turn = planIntegration({ message: input.message, spec: input.spec, scope: input.scope ?? "company", existing });
  if (turn.reused || !turn.tools.length) return { turn, page: await loadIntegrationPage() };
  if (input.scope === "global") {
    const slug = await uniqueSlug(turn.tools[0]?.slug || "draft", async (value) =>
      Boolean(await prisma.integrationBlueprint.findUnique({ where: { slug: value }, select: { id: true } })),
    );
    const created = await prisma.integrationBlueprint.create({
      data: {
        slug,
        name: slug,
        description: turn.explanation,
        visibility: "internal",
        limitations: asJson(turn.limitations),
        status: "draft",
        createdById: session.user.id,
        endpoints: { create: turn.endpoints.map((endpoint) => endpointData(endpoint, "global")) },
      },
    });
    await persistDraftTools(session, "blueprint", created.id, turn);
    await prisma.permissionPolicy.create({
      data: { scope: "integration", blueprintId: created.id, rules: asJson(turn.rules) },
    });
    turn.created = true;
    turn.integrationId = created.id;
    await audit(session, "integration.agent_draft", created.id, { modelCalled: false, tools: turn.tools.length });
  } else if (orgId) {
    const slug = await uniqueSlug(turn.tools[0]?.slug || "draft", async (value) =>
      Boolean(await prisma.companyIntegration.findUnique({ where: { orgId_slug: { orgId, slug: value } }, select: { id: true } })),
    );
    const created = await prisma.companyIntegration.create({
      data: {
        orgId,
        slug,
        name: slug,
        description: turn.explanation,
        status: "draft",
        createdById: session.user.id,
        endpoints: { create: turn.endpoints.map((endpoint) => endpointData(endpoint, "local")) },
      },
    });
    await persistDraftTools(session, "company", created.id, turn);
    await prisma.permissionPolicy.create({
      data: { scope: "company", orgId, companyIntegrationId: created.id, rules: asJson(turn.rules) },
    });
    turn.created = true;
    turn.integrationId = created.id;
    await audit(session, "integration.agent_draft", created.id, { modelCalled: false, tools: turn.tools.length });
  }
  return { turn, page: await loadIntegrationPage() };
}

async function persistDraftTools(
  session: AuthenticatedSession,
  owner: "blueprint" | "company",
  ownerId: string,
  turn: AgentTurn,
): Promise<void> {
  for (const tool of turn.tools) {
    await prisma.toolDefinition.create({
      data: {
        ...(owner === "blueprint" ? { blueprintId: ownerId } : { companyIntegrationId: ownerId }),
        slug: tool.slug,
        name: tool.name,
        description: tool.description,
        kind: tool.kind,
        inputSchema: asJson(tool.inputSchema),
        outputSchema: asJson(tool.outputSchema),
        executionPolicy: asJson(tool.executionPolicy),
        status: "draft",
        createdById: session.user.id,
        versions: {
          create: {
            version: 1,
            status: "draft",
            graph: asJson(tool.graph),
            inputSchema: asJson(tool.inputSchema),
            outputSchema: asJson(tool.outputSchema),
            policySnapshot: asJson(tool.executionPolicy),
            notes: "agent_draft",
            createdById: session.user.id,
          },
        },
      },
    });
  }
}

export async function explainTool(toolId: string): Promise<{ explanation: string; modelCalled: false }> {
  const session = await reader();
  const tool = await prisma.toolDefinition.findUnique({
    where: { id: toolId },
    include: { companyIntegration: true, versions: { orderBy: { version: "desc" }, take: 1 }, policies: true },
  });
  if (!tool) fail("INTEGRATION_NOT_FOUND");
  if (tool.companyIntegration) assertCompany(session, tool.companyIntegration.orgId);
  const version = tool.versions[0];
  const execution = policyOf(tool.executionPolicy);
  const rules = tool.policies.flatMap((policy) => rulesOf(policy.rules));
  return {
    modelCalled: false,
    explanation: `${tool.name} is ${tool.status}, published version ${tool.publishedVersion}. Approval is ${execution.requiresApproval ? "required" : "not required"}. ${rules.length} policy rows are attached. The latest draft version is ${version?.version ?? 0}. No model was called.`,
  };
}

type ToolRun = {
  status: string;
  output: unknown;
  error: string;
  operation: string;
  decision: string;
  policyVersion: number;
};

export async function testPublishedTool(raw: unknown): Promise<ToolRun> {
  const session = await manager();
  const input = parse(toolTestSchema, raw);
  const agent = await prisma.hubAgent.findUnique({ where: { id: input.agentId } });
  if (!agent) fail("AGENT_REQUIRED");
  assertCompany(session, agent.orgId);
  return executeBoundTool({
    orgId: agent.orgId,
    actor: session.user.id,
    agentId: agent.id,
    agentSlug: agent.slug,
    toolId: input.toolId,
    connectionId: input.connectionId,
    args: input.input,
    correlationId: crypto.randomUUID(),
  });
}

export async function executeBoundTool(input: {
  orgId: string;
  actor: string;
  agentId: string;
  agentSlug: string;
  toolId?: string;
  toolName?: string;
  connectionId?: string;
  args: Record<string, unknown>;
  correlationId: string;
}): Promise<ToolRun> {
  const binding = await prisma.agentBinding.findFirst({
    where: {
      orgId: input.orgId,
      agentId: input.agentId,
      status: "active",
      ...(input.toolId ? { toolId: input.toolId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.toolName ? { tool: { slug: input.toolName, status: "published" } } : {}),
    },
    include: {
      tool: { include: { versions: true, companyIntegration: true, blueprint: true } },
      connection: { include: { credential: true, companyIntegration: true } },
      policy: true,
    },
  });
  if (!binding || binding.tool.status !== "published" || binding.tool.publishedVersion < 1) {
    await recordExecution(input, { status: "denied", error: "TOOL_NOT_PUBLISHED", decision: "deny", operation: "", policyVersion: 0, output: null, version: 0 });
    fail("TOOL_NOT_PUBLISHED");
  }
  if (binding.connection.orgId !== input.orgId || binding.connection.credential?.revokedAt) {
    await recordExecution(input, { status: "denied", error: "FORBIDDEN", decision: "deny", operation: "", policyVersion: 0, output: null, version: 0, toolId: binding.toolId, connectionId: binding.connectionId });
    fail("FORBIDDEN");
  }
  const version = binding.tool.versions.find((item) => item.version === binding.tool.publishedVersion);
  if (!version) fail("TOOL_NOT_PUBLISHED");
  const endpoints = await endpointsOf(binding.tool.blueprintId, binding.tool.companyIntegrationId);
  const graph = graphOf(version.graph);
  const operation = graph.nodes.find((node) => node.type === "request")?.endpointId || binding.tool.slug;
  const effect = strongest(endpoints.filter((endpoint) => graphMentions(graph, endpoint.operationId)).map((endpoint) => endpoint.sideEffect));
  const policyRows = await prisma.permissionPolicy.findMany({
    where: {
      OR: [
        { id: binding.policyId ?? "" },
        { toolId: binding.toolId },
        { agentId: binding.agentId },
        { companyIntegrationId: binding.connection.companyIntegrationId },
        { orgId: input.orgId, scope: "company" },
        { scope: "platform" },
      ],
    },
  });
  const rules = policyRows.flatMap((row) => rulesOf(row.rules));
  const policyVersion = policyRows.reduce((max, row) => Math.max(max, row.version), 0);
  const execution = policyOf(version.policySnapshot);
  const decision = evaluatePolicy(
    rules,
    {
      tool: binding.tool.slug,
      operation,
      sideEffect: effect,
      resource: operation,
      parameters: input.args,
      environment: execution.environment,
      now: new Date(),
    },
    policyVersion,
  );
  const approved = Boolean(
    await prisma.approvalRequest.findFirst({
      where: { subjectType: "tool", subjectId: binding.toolId, status: "approved", OR: [{ orgId: input.orgId }, { orgId: null }] },
      select: { id: true },
    }),
  );
  if (decision.decision !== "allow" || ((decision.approval || execution.requiresApproval) && !approved)) {
    const error = decision.decision !== "allow" ? "POLICY_DENIED" : "APPROVAL_REQUIRED";
    const status = error === "APPROVAL_REQUIRED" ? "approval_required" : "denied";
    await recordExecution(input, {
      status,
      error,
      decision: decision.decision,
      operation,
      policyVersion,
      output: null,
      version: version.version,
      toolId: binding.toolId,
      connectionId: binding.connectionId,
    });
    fail(error);
  }
  const credential = binding.connection.credential;
  const envelope = openEnvelope(credential?.sealedSecret ?? "");
  const metadata = metadataOf(credential?.metadata);
  if (credential?.expiresAt && credential.expiresAt.getTime() < Date.now() && envelope.refreshToken && metadata.tokenUrl && metadata.clientId) {
    const refreshed = await refreshAccess(
      { tokenUrl: metadata.tokenUrl, clientId: metadata.clientId, clientSecret: envelope.clientSecret, refreshToken: envelope.refreshToken },
      tokenFetch(binding.connection.internal),
    );
    const merged = { ...envelope, ...refreshed.envelope };
    await prisma.credentialReference.update({
      where: { id: credential.id },
      data: { sealedSecret: sealEnvelope(merged), expiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt) : null, rotatedAt: new Date() },
    });
    Object.assign(envelope, merged);
  }
  const started = Date.now();
  const result = await runIntegrationWorkflow({
    tool: binding.tool.slug,
    graph,
    args: input.args,
    endpoints,
    rules,
    policyVersion,
    execution,
    baseUrl: binding.connection.baseUrl || binding.tool.blueprint?.baseUrl || "",
    internal: binding.connection.internal,
    authHeaders: authHeadersFor(authOf(binding.connection.authMethod), envelope, metadata),
    approved,
    quotaKey: `${input.orgId}:${binding.toolId}:${input.agentSlug}`,
  });
  await recordExecution(input, {
    status: result.status,
    error: result.error,
    decision: decision.decision,
    operation: result.operation || operation,
    policyVersion,
    output: result.output,
    version: version.version,
    toolId: binding.toolId,
    connectionId: binding.connectionId,
    durationMs: Date.now() - started,
  });
  if (result.error === "MCP_URL_BLOCKED" || result.error === "MCP_URL_INVALID" || result.error === "MCP_URL_INSECURE") fail("DESTINATION_BLOCKED");
  return {
    status: result.status,
    output: result.output,
    error: result.error,
    operation: result.operation || operation,
    decision: decision.decision,
    policyVersion,
  };
}

function strongest(effects: SideEffect[]): SideEffect {
  if (effects.includes("destructive")) return "destructive";
  if (effects.includes("sensitive")) return "sensitive";
  if (effects.includes("write")) return "write";
  return "read";
}

async function recordExecution(
  input: { orgId: string; actor: string; agentId: string; correlationId: string; toolId?: string },
  result: {
    status: string;
    error: string;
    decision: string;
    operation: string;
    policyVersion: number;
    output: unknown;
    version: number;
    toolId?: string;
    connectionId?: string;
    durationMs?: number;
  },
): Promise<void> {
  await prisma.toolExecution.create({
    data: {
      orgId: input.orgId,
      toolId: result.toolId || input.toolId || "",
      toolVersion: result.version,
      agentId: input.agentId,
      connectionId: result.connectionId,
      actor: input.actor,
      correlationId: input.correlationId,
      decision: result.decision,
      policyVersion: result.policyVersion,
      status: result.status,
      operation: result.operation,
      finishedAt: new Date(),
      durationMs: result.durationMs ?? 0,
      error: result.error,
      summary: asJson(sanitizeForLog(result.output)),
    },
  });
}

export async function clientCredentials(connectionId: string): Promise<IntegrationPage> {
  const session = await credentialUser();
  const connection = await prisma.connection.findUnique({ where: { id: connectionId }, include: { credential: true } });
  if (!connection?.credential) fail("CREDENTIAL_REQUIRED");
  assertCompany(session, connection.orgId);
  const metadata = metadataOf(connection.credential.metadata);
  const envelope = openEnvelope(connection.credential.sealedSecret);
  if (!metadata.tokenUrl || !metadata.clientId || !envelope.clientSecret) fail("CREDENTIAL_REQUIRED");
  const fetched = await exchangeClient(
    { tokenUrl: metadata.tokenUrl, clientId: metadata.clientId, clientSecret: envelope.clientSecret, scopes: metadata.scopes ?? [] },
    tokenFetch(connection.internal),
  );
  await prisma.credentialReference.update({
    where: { id: connection.credential.id },
    data: {
      sealedSecret: sealEnvelope({ ...envelope, ...fetched.envelope }),
      expiresAt: fetched.expiresAt ? new Date(fetched.expiresAt) : null,
      rotatedAt: new Date(),
    },
  });
  await audit(session, "integration.client_credentials", connection.id, { hasSecret: true });
  return loadIntegrationPage();
}
