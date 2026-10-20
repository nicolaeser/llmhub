import "server-only";
import prisma from "@/lib/db/prisma";
import { authHeadersFor, metadataOf, openEnvelope, sealEnvelope } from "@/lib/integrations/credentials";
import { refreshAccess } from "@/lib/integrations/oauth";
import { evaluatePolicy } from "@/lib/integrations/policy";
import { asJson, authOf, endpointDraft, fail, graphMentions, graphOf, policyOf, rulesOf, strongest } from "@/lib/integrations/records";
import { runIntegrationWorkflow, tokenFetch } from "@/lib/integrations/runtime";
import { sanitizeForLog } from "@/lib/integrations/sanitize";
import type { EndpointDraft, ToolRun } from "@/types/integrations";

export async function endpointsOf(blueprintId: string | null, companyIntegrationId: string | null): Promise<EndpointDraft[]> {
  const rows = await prisma.endpointDefinition.findMany({
    where: companyIntegrationId ? { companyIntegrationId } : { blueprintId: blueprintId ?? "" },
  });
  return rows.map((row) => endpointDraft(row));
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
