import "server-only";
import prisma from "@/lib/db/prisma";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf } from "@/lib/auth/scope";
import { reader } from "@/lib/integrations/guards";
import {
  authOf,
  endpointDraft,
  graphOrEmpty,
  oneOf,
  policyOf,
  rulesOf,
  scopeOf,
  statusOf,
  strings,
  visibilityOf,
} from "@/lib/integrations/records";
import { blueprintListed, publicCredential } from "@/lib/integrations/scope";
import type { ExecutionView, IntegrationPage, ToolView } from "@/types/integrations";

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
