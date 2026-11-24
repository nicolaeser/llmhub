import "server-only";
import prisma from "@/lib/db/prisma";
import { GateError } from "@/lib/gateway/errors";
import { executeBoundTool } from "@/lib/integrations/execution";
import { toolCard, visibleTools, type CallableTool } from "@/lib/integrations/mcp-protocol";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/integrations/workflow";
import { McpEndpointError, type McpEndpointTools } from "@/lib/mcp/endpoint";
import { executionPolicySchema, policyRuleSchema } from "@/schemas/integrations";
import type { JsonMap, Principal } from "@/types/gateway";
import type { PolicyRule, SideEffect } from "@/types/integrations";

function policyOf(value: unknown) {
  const parsed = executionPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_EXECUTION_POLICY;
}

function sideOf(value: string | undefined, method: string | undefined): SideEffect {
  if (value === "read" || value === "write" || value === "destructive" || value === "sensitive") return value;
  const verb = (method ?? "GET").toUpperCase();
  return verb === "GET" || verb === "HEAD" ? "read" : "write";
}

function rulesOf(value: unknown): PolicyRule[] {
  const parsed = policyRuleSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

const INTEGRATION_MCP_INFO = { name: "llmhub-integrations", version: "1" };
const SERVER_ERROR = -32000;
const POLICY_ERROR = -32001;
const POLICY_ERRORS = new Set(["POLICY_DENIED", "FORBIDDEN", "APPROVAL_REQUIRED"]);

function integrationError(message: string): McpEndpointError {
  return new McpEndpointError(POLICY_ERRORS.has(message) ? POLICY_ERROR : SERVER_ERROR, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function integrationMcpTools(principal: Principal, agentSlug: string): McpEndpointTools {
  const agentOf = async () => {
    if (!principal.orgId) throw new GateError(403, "permission_denied", "company context required");
    const agent = agentSlug
      ? await prisma.hubAgent.findUnique({ where: { orgId_slug: { orgId: principal.orgId, slug: agentSlug } } })
      : null;
    if (!agent) throw integrationError("AGENT_REQUIRED");
    return { agent, orgId: principal.orgId };
  };
  return {
    info: INTEGRATION_MCP_INFO,
    async list() {
      const { agent, orgId } = await agentOf();
      return visibleTools(await callableFor(agent.id, orgId), new Date(), "production").map(toolCard) as JsonMap[];
    },
    async call(name, args) {
      const { agent, orgId } = await agentOf();
      const tool = (await callableFor(agent.id, orgId)).find((item) => item.name === name);
      if (!tool) throw integrationError("TOOL_NOT_PUBLISHED");
      try {
        const result = await executeBoundTool({
          orgId,
          actor: principal.actor,
          agentId: agent.id,
          agentSlug: agent.slug,
          toolName: name,
          connectionId: tool.connectionId,
          args,
          correlationId: principal.trace?.endpoint || crypto.randomUUID(),
        });
        const output = result.output ?? null;
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          ...(isObject(output) ? { structuredContent: output } : {}),
          isError: result.status !== "succeeded",
        };
      } catch (err) {
        throw integrationError(err instanceof Error && /^[A-Z0-9_]+$/.test(err.message) ? err.message : "upstream_failed");
      }
    },
  };
}

async function callableFor(agentId: string, orgId: string): Promise<CallableTool[]> {
  const bindings = await prisma.agentBinding.findMany({
    where: { agentId, orgId, status: "active", tool: { status: "published" } },
    include: { tool: { include: { versions: true } }, policy: true, connection: true },
  });
  const rows = await prisma.permissionPolicy.findMany({
    where: { OR: [{ agentId }, { orgId, scope: "company" }, { scope: "platform" }, { toolId: { in: bindings.map((row) => row.toolId) } }] },
  });
  const approved = await prisma.approvalRequest.findMany({
    where: { subjectType: "tool", subjectId: { in: bindings.map((row) => row.toolId) }, status: "approved" },
    select: { subjectId: true },
  });
  const approvedIds = new Set(approved.map((row) => row.subjectId));
  const companyIds = bindings.map((row) => row.tool.companyIntegrationId).filter((id): id is string => Boolean(id));
  const blueprintIds = bindings.map((row) => row.tool.blueprintId).filter((id): id is string => Boolean(id));
  const endpoints = companyIds.length || blueprintIds.length
    ? await prisma.endpointDefinition.findMany({
        where: {
          OR: [
            ...(companyIds.length ? [{ companyIntegrationId: { in: companyIds } }] : []),
            ...(blueprintIds.length ? [{ blueprintId: { in: blueprintIds } }] : []),
          ],
        },
        select: { operationId: true, sideEffect: true, companyIntegrationId: true, blueprintId: true },
      })
    : [];
  return bindings.flatMap((binding) => {
    const version = binding.tool.versions.find((item) => item.version === binding.tool.publishedVersion);
    if (!version) return [];
    const graph = version.graph && typeof version.graph === "object" ? (version.graph as { nodes?: { type?: string; endpointId?: string; method?: string }[] }) : {};
    const request = graph.nodes?.find((node) => node.type === "request");
    const operation = request?.endpointId || binding.tool.slug;
    const related = endpoints.filter((endpoint) =>
      binding.tool.companyIntegrationId
        ? endpoint.companyIntegrationId === binding.tool.companyIntegrationId
        : endpoint.blueprintId === binding.tool.blueprintId,
    );
    const matched = related.find((endpoint) => endpoint.operationId === operation);
    const rules = rows.filter((row) => !row.toolId || row.toolId === binding.toolId).flatMap((row) => rulesOf(row.rules));
    const execution = policyOf(version.policySnapshot);
    return [{
      name: binding.tool.slug,
      description: binding.tool.description || binding.tool.name,
      inputSchema: (binding.tool.inputSchema && typeof binding.tool.inputSchema === "object" ? binding.tool.inputSchema : { type: "object" }) as Record<string, unknown>,
      toolId: binding.toolId,
      connectionId: binding.connectionId,
      version: version.version,
      operation,
      sideEffect: sideOf(matched?.sideEffect, request?.method),
      rules,
      policyVersion: rows.reduce((max, row) => Math.max(max, row.version), 1),
      execution,
      approved: approvedIds.has(binding.toolId),
    } satisfies CallableTool];
  });
}
