import "server-only";
import prisma from "@/lib/db/prisma";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { assertCompany, assertOwner, assertPlatform, audit, manager, orgFor, publisher } from "@/lib/integrations/guards";
import { ingestDocument } from "@/lib/integrations/ingest";
import { loadIntegrationPage } from "@/lib/integrations/page";
import { asJson, endpointData, endpointDraft, fail, parse, uniqueSlug, visibilityOf } from "@/lib/integrations/records";
import { canInstantiate } from "@/lib/integrations/scope";
import {
  blueprintVisibilitySchema,
  companyDraftSchema,
  endpointSelectionSchema,
  importSpecSchema,
  instantiateSchema,
  manualEndpointSchema,
} from "@/schemas/integrations";
import type { EndpointDraft, IntegrationPage } from "@/types/integrations";

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
