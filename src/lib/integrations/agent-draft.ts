import "server-only";
import prisma from "@/lib/db/prisma";
import { planIntegration, type KnownIntegration } from "@/lib/integrations/agent-plan";
import { assertPlatform, audit, manager, orgFor, publisher } from "@/lib/integrations/guards";
import { loadIntegrationPage } from "@/lib/integrations/page";
import { asJson, endpointData, parse, uniqueSlug } from "@/lib/integrations/records";
import { agentMessageSchema } from "@/schemas/integrations";
import type { AuthenticatedSession } from "@/types/auth";
import type { AgentTurn, IntegrationPage } from "@/types/integrations";

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
