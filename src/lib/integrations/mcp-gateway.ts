import "server-only";
import prisma from "@/lib/db/prisma";
import { GateError } from "@/lib/gateway/errors";
import { executeBoundTool } from "@/lib/integrations/execution";
import { parseRpc, rpcFail, rpcOk, toolCard, visibleTools, type CallableTool } from "@/lib/integrations/mcp-protocol";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/integrations/workflow";
import { executionPolicySchema, policyRuleSchema } from "@/schemas/integrations";
import type { Principal } from "@/types/gateway";
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

const PROTOCOL = "2025-06-18";

function fail(id: unknown, message: string): Record<string, unknown> {
  const code = message === "POLICY_DENIED" || message === "FORBIDDEN" || message === "APPROVAL_REQUIRED" ? -32001 : -32000;
  return rpcFail(id, code, message);
}

export async function handleIntegrationMcp(principal: Principal, body: unknown, agentSlug: string): Promise<Record<string, unknown>> {
  const parsed = parseRpc(body);
  if ("error" in parsed) return rpcFail(null, -32600, parsed.error);
  if (parsed.method === "initialize") {
    return rpcOk(parsed.id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "llmhub-integrations", version: "1" } });
  }
  if (parsed.method === "ping") return rpcOk(parsed.id, {});
  if (!principal.orgId) throw new GateError(403, "permission_denied", "company context required");
  if (!agentSlug) return fail(parsed.id, "AGENT_REQUIRED");
  const agent = await prisma.hubAgent.findUnique({ where: { orgId_slug: { orgId: principal.orgId, slug: agentSlug } } });
  if (!agent) return fail(parsed.id, "AGENT_REQUIRED");
  if (parsed.method === "tools/list") {
    const tools = await callableFor(agent.id, principal.orgId);
    return rpcOk(parsed.id, { tools: visibleTools(tools, new Date(), "production").map(toolCard) });
  }
  if (parsed.method === "tools/call") {
    const name = typeof parsed.params.name === "string" ? parsed.params.name : "";
    const args = parsed.params.arguments && typeof parsed.params.arguments === "object" && !Array.isArray(parsed.params.arguments)
      ? (parsed.params.arguments as Record<string, unknown>)
      : {};
    const tools = await callableFor(agent.id, principal.orgId);
    const tool = tools.find((item) => item.name === name);
    if (!tool) return fail(parsed.id, "TOOL_NOT_PUBLISHED");
    try {
      const result = await executeBoundTool({
        orgId: principal.orgId,
        actor: principal.actor,
        agentId: agent.id,
        agentSlug: agent.slug,
        toolName: name,
        connectionId: tool.connectionId,
        args,
        correlationId: principal.trace?.endpoint || crypto.randomUUID(),
      });
      return rpcOk(parsed.id, {
        content: [{ type: "text", text: JSON.stringify(result.output ?? null) }],
        structuredContent: result.output ?? null,
        isError: result.status !== "succeeded",
      });
    } catch (err) {
      const message = err instanceof Error && /^[A-Z0-9_]+$/.test(err.message) ? err.message : "upstream_failed";
      return fail(parsed.id, message);
    }
  }
  return rpcFail(parsed.id, -32601, "method_not_found");
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
