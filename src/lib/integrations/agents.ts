import "server-only";
import prisma from "@/lib/db/prisma";
import { isPrismaCode } from "@/lib/auth/errors";
import { companyOf } from "@/lib/auth/scope";
import { endpointsOf } from "@/lib/integrations/execution";
import { assertCompany, assertPlatform, audit, manager, orgFor, publisher, reader } from "@/lib/integrations/guards";
import { loadIntegrationPage } from "@/lib/integrations/page";
import { evaluatePolicy } from "@/lib/integrations/policy";
import { asJson, fail, graphMentions, graphOf, parse, policyOf, rulesOf, strongest } from "@/lib/integrations/records";
import { slugify } from "@/lib/integrations/sanitize";
import { agentSchema, bindingSchema, policySaveSchema } from "@/schemas/integrations";
import type { EffectivePreview, IntegrationPage } from "@/types/integrations";

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
