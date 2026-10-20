import "server-only";
import prisma from "@/lib/db/prisma";
import { isPrismaCode } from "@/lib/auth/errors";
import { endpointsOf, executeBoundTool } from "@/lib/integrations/execution";
import { assertCompany, assertOwner, assertPlatform, audit, manager, ownedTool, publisher, reader } from "@/lib/integrations/guards";
import { transition } from "@/lib/integrations/lifecycle";
import { loadIntegrationPage } from "@/lib/integrations/page";
import { evaluatePolicy } from "@/lib/integrations/policy";
import { asJson, fail, graphMentions, graphOf, parse, policyOf, rulesOf, statusOf } from "@/lib/integrations/records";
import { slugify } from "@/lib/integrations/sanitize";
import { publicationBlock } from "@/lib/integrations/scope";
import { approvalDecisionSchema, publishSchema, rollbackSchema, saveToolSchema, toolTestSchema } from "@/schemas/integrations";
import type { EndpointDraft, IntegrationPage, PolicyRule, ToolRun } from "@/types/integrations";

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
