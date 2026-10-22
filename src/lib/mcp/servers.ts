import "server-only";
import prisma from "@/lib/db/prisma";
import { requireActor } from "@/lib/auth/guards";
import { companyOf, inCompany } from "@/lib/auth/scope";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { AuthError, isPrismaCode } from "@/lib/auth/errors";
import { writeAudit } from "@/lib/audit";
import { seal } from "@/lib/crypto";
import { replaceCompanyMcpAssignments, replaceMcpAssignments, targetOptions } from "@/lib/mcp/assignments";
import { builderModels } from "@/lib/mcp/builder";
import { managesMcpRules, mcpAccess, requireMcpManager, seesMcp, visibleToCompany } from "@/lib/mcp/scope";
import { ensureBuiltinRoles, saveMcpInstallation } from "@/lib/mcp/catalog";
import { toolSpecOf } from "@/lib/mcp/hosted";
import { mcpOAuthRedirectUri } from "@/lib/mcp/oauth";
import { assertRemoteAuth, assertUrl, connectionFields, parse, secretFor, secretRequired } from "@/lib/mcp/server-input";
import { probe, storeProbe } from "@/lib/mcp/server-probe";
import { auditShape, loadRow, scopedView, serverSelect, viewOf, type ServerRow } from "@/lib/mcp/server-view";
import { serverRecord } from "@/lib/mcp/toolset";
import { BUILDER_MODEL_KEY, authUsesName, hostedServerSchema, mcpAssignmentsSchema, mcpServerInputSchema } from "@/schemas/mcp";
import type { Prisma } from "@/generated/prisma/client";

export async function loadMcpServerList() {
  const session = await requireActor();
  if (!seesMcp(session)) throw new AuthError("FORBIDDEN");
  const company = companyOf(session);
  const access = mcpAccess(session, company);
  const [rows, setting, models, companies] = await Promise.all([
    prisma.mcpServer.findMany({
      where: company ? visibleToCompany(company) : undefined,
      select: serverSelect,
      orderBy: { name: "asc" },
    }),
    access.canManage ? prisma.setting.findUnique({ where: { key: BUILDER_MODEL_KEY } }) : null,
    access.canManage ? builderModels() : [],
    access.canInstall
      ? prisma.organization.findMany({
          where: company ? { id: company } : undefined,
          select: { id: true, alias: true },
          orderBy: { alias: "asc" },
        })
      : [],
  ]);
  return {
    servers: rows.map((row) => viewOf(row, access.canManage, company)),
    ...access,
    companyId: company,
    companies,
    redirectUri: access.canManage ? mcpOAuthRedirectUri() : "",
    builderModel: setting?.value ?? "",
    models,
    canTestModels: access.canManage && hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE),
  };
}

export async function loadCompanyMcpServers(rawOrgId: unknown) {
  const session = await requireActor();
  if (!seesMcp(session)) throw new AuthError("FORBIDDEN");
  const orgId = typeof rawOrgId === "string" ? rawOrgId : "";
  if (!orgId) throw new Error("MISSING_ID");
  if (!inCompany(session, orgId)) throw new AuthError("FORBIDDEN");
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, alias: true } });
  if (!org) throw new Error("ORG_NOT_FOUND");
  const rows = await prisma.mcpServer.findMany({ where: { template: true }, select: serverSelect, orderBy: { name: "asc" } });
  const access = mcpAccess(session, companyOf(session));
  return {
    company: org,
    servers: rows.map((row) => viewOf(row, access.canManage, org.id)),
    canInstall: access.canInstall,
  };
}

export async function saveCompanyMcpInstallation(raw: unknown) {
  const saved = await saveMcpInstallation(raw);
  const session = await requireActor();
  return { server: viewOf(await loadRow(saved.serverId), mcpAccess(session, companyOf(session)).canManage, saved.orgId) };
}

export async function presentMcpServer(id: string) {
  const session = await requireActor();
  if (!seesMcp(session)) throw new AuthError("FORBIDDEN");
  return { server: scopedView(await loadRow(id), session) };
}

export async function createMcpServer(raw: unknown) {
  const session = await requireMcpManager();
  const input = parse(mcpServerInputSchema, raw);
  assertUrl(input.url, input.internal);
  assertRemoteAuth(input.authType);
  const authSecret = secretFor(input.authType, input, "");
  if (secretRequired(input) && !authSecret) throw new Error("MCP_SECRET_REQUIRED");
  let created: ServerRow;
  try {
    created = await prisma.mcpServer.create({
      data: {
        name: input.name,
        description: input.description,
        url: input.url,
        authType: input.authType,
        ...connectionFields(input),
        authSecret,
        internal: input.internal,
        enabled: input.enabled,
        global: input.global,
        toolsRestricted: input.toolsRestricted,
        allowedTools: [...new Set(input.allowedTools)],
      },
      select: serverSelect,
    });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error("NAME_EXISTS", { cause: err });
    throw err;
  }
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.create",
    objectType: "mcp_server",
    objectId: created.id,
    after: auditShape(created),
  });
  const refreshed = await storeProbe(created.id, await probe(serverRecord(created)));
  return { server: scopedView(refreshed, session) };
}

export async function createHostedMcpServer(raw: unknown) {
  const session = await requireMcpManager();
  const input = parse(hostedServerSchema, raw);
  assertUrl(input.baseUrl, input.internal);
  const tools = input.tools.map(toolSpecOf);
  let created: ServerRow;
  try {
    created = await prisma.mcpServer.create({
      data: {
        name: input.name,
        description: input.description,
        url: input.baseUrl,
        kind: "hosted",
        spec: { tools: input.tools } as Prisma.InputJsonValue,
        authType: input.authType,
        authHeader: authUsesName(input.authType) ? input.authHeader : "",
        authSecret: input.secret.trim() ? seal(input.secret.trim()) : "",
        internal: input.internal,
        enabled: true,
        template: input.template,
        tools: tools as unknown as Prisma.InputJsonValue,
        refreshedAt: new Date(),
      },
      select: serverSelect,
    });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error("NAME_EXISTS", { cause: err });
    throw err;
  }
  await ensureBuiltinRoles(created.id);
  const roles = await prisma.mcpRole.findMany({ where: { serverId: created.id }, select: { id: true, key: true } });
  const roleIds = new Map(roles.map((role) => [role.key, role.id]));
  const names = new Set(input.tools.map((tool) => tool.name));
  const assignments = input.assignments.map((row) => ({
    scope: row.scope,
    id: row.id,
    mode: row.mode,
    blockedTools: row.blockedTools.filter((name) => names.has(name)),
    blockedActions: row.blockedActions,
    roleId: row.roleKey ? roleIds.get(row.roleKey) ?? "" : "",
  }));
  if (input.global || assignments.length) {
    const saved = await replaceMcpAssignments(created.id, input.global, assignments);
    if (!saved) {
      await prisma.mcpServer.delete({ where: { id: created.id } });
      throw new Error("VALIDATION");
    }
  }
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.create",
    objectType: "mcp_server",
    objectId: created.id,
    after: {
      ...auditShape(created),
      kind: "hosted",
      tools: tools.map((tool) => tool.name),
      global: input.global,
      template: input.template,
      assignments: assignments.length,
    },
  });
  return { server: scopedView(await loadRow(created.id), session) };
}

export async function updateMcpServer(raw: { id: string } & Record<string, unknown>) {
  const session = await requireMcpManager();
  if (!raw?.id || typeof raw.id !== "string") throw new Error("MISSING_ID");
  const input = parse(mcpServerInputSchema, raw);
  assertUrl(input.url, input.internal);
  const before = await loadRow(raw.id);
  if (before.kind === "hosted") {
    if (input.authType === "oauth") throw new Error("VALIDATION");
    const authSecret = secretFor(input.authType, input, before.authSecret);
    if (secretRequired(input) && !authSecret) throw new Error("MCP_SECRET_REQUIRED");
    const fields = connectionFields(input);
    let updated: ServerRow;
    try {
      updated = await prisma.mcpServer.update({
        where: { id: raw.id },
        data: {
          name: input.name,
          description: input.description,
          url: input.url,
          authType: input.authType,
          ...fields,
          authSecret,
          internal: input.internal,
          enabled: input.enabled,
          global: input.global,
          toolsRestricted: input.toolsRestricted,
          allowedTools: [...new Set(input.allowedTools)],
        },
        select: serverSelect,
      });
    } catch (err) {
      if (isPrismaCode(err, "P2002")) throw new Error("NAME_EXISTS", { cause: err });
      if (isPrismaCode(err, "P2025")) throw new Error("NOT_FOUND", { cause: err });
      throw err;
    }
    await writeAudit({
      actor: session.user.id,
      action: "mcp_server.update",
      objectType: "mcp_server",
      objectId: updated.id,
      before: auditShape(before),
      after: auditShape(updated),
    });
    return { server: scopedView(updated, session) };
  }
  assertRemoteAuth(input.authType);
  const authSecret = secretFor(input.authType, input, before.authSecret);
  if (secretRequired(input) && !authSecret) throw new Error("MCP_SECRET_REQUIRED");
  const fields = connectionFields(input);
  const identityChanged =
    before.url !== input.url ||
    before.authType !== input.authType ||
    before.oauthGrant !== fields.oauthGrant ||
    before.oauthClientId !== fields.oauthClientId ||
    before.authSecret !== authSecret;
  const connectionChanged =
    identityChanged ||
    before.authHeader !== fields.authHeader ||
    before.oauthScopes !== fields.oauthScopes ||
    before.internal !== input.internal;
  let updated: ServerRow;
  try {
    updated = await prisma.$transaction(async (tx) => {
      if (identityChanged) await tx.mcpOAuthLogin.deleteMany({ where: { serverId: raw.id } });
      return tx.mcpServer.update({
        where: { id: raw.id },
        data: {
          name: input.name,
          description: input.description,
          url: input.url,
          authType: input.authType,
          ...fields,
          authSecret,
          internal: input.internal,
          enabled: input.enabled,
          global: input.global,
          toolsRestricted: input.toolsRestricted,
          allowedTools: [...new Set(input.allowedTools)],
          ...(connectionChanged ? { lastError: "", refreshedAt: null } : {}),
          ...(before.url !== input.url ? { tools: [], transport: "streamable_http", protocolVersion: "" } : {}),
        },
        select: serverSelect,
      });
    });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error("NAME_EXISTS", { cause: err });
    if (isPrismaCode(err, "P2025")) throw new Error("NOT_FOUND", { cause: err });
    throw err;
  }
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.update",
    objectType: "mcp_server",
    objectId: updated.id,
    before: auditShape(before),
    after: { ...auditShape(updated), ...(identityChanged && before.oauthLogin ? { oauthDisconnected: true } : {}) },
  });
  if (!updated.enabled) return { server: scopedView(updated, session) };
  const refreshed = await storeProbe(updated.id, await probe(serverRecord(updated)));
  return { server: scopedView(refreshed, session) };
}

export async function setMcpServerEnabled(input: { id: string; enabled: boolean }) {
  const session = await requireMcpManager();
  if (!input?.id) throw new Error("MISSING_ID");
  const before = await loadRow(input.id);
  const updated = await prisma.mcpServer.update({
    where: { id: input.id },
    data: { enabled: Boolean(input.enabled) },
    select: serverSelect,
  });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.update",
    objectType: "mcp_server",
    objectId: updated.id,
    before: { enabled: before.enabled },
    after: { enabled: updated.enabled },
  });
  return { server: scopedView(updated, session) };
}

export async function deleteMcpServer(id: string) {
  const session = await requireMcpManager();
  if (!id) throw new Error("MISSING_ID");
  const before = await loadRow(id);
  await prisma.mcpServer.delete({ where: { id } });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.delete",
    objectType: "mcp_server",
    objectId: id,
    before: auditShape(before),
  });
  return { id };
}

export async function loadMcpTargets() {
  const session = await requireActor();
  const company = companyOf(session);
  if (!managesMcpRules(session, company)) throw new AuthError("FORBIDDEN");
  const options = await targetOptions();
  if (!company) return { options };
  return {
    options: {
      org: options.org.filter((item) => item.id === company),
      team: options.team.filter((item) => item.orgId === company),
      project: options.project.filter((item) => item.orgId === company),
      member: options.member.filter((item) => item.orgId === company),
      key: options.key.filter((item) => item.orgId === company),
    },
  };
}

export async function saveMcpAssignments(raw: unknown) {
  const session = await requireActor();
  const company = companyOf(session);
  if (!managesMcpRules(session, company)) throw new AuthError("FORBIDDEN");
  const input = parse(mcpAssignmentsSchema, raw);
  if (company && !(await prisma.mcpServer.count({ where: { AND: [{ id: input.serverId }, visibleToCompany(company)] } }))) {
    throw new Error("NOT_FOUND");
  }
  const before = await loadRow(input.serverId);
  const saved = company
    ? await replaceCompanyMcpAssignments(input.serverId, company, input.assignments)
    : await replaceMcpAssignments(input.serverId, input.global, input.assignments);
  if (!saved) throw new Error("NOT_FOUND");
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.assign",
    objectType: "mcp_server",
    objectId: input.serverId,
    before: { global: before.global, assignments: before.assignments.length },
    after: {
      global: saved.global,
      assignments: saved.assignments.map((row) => ({
        scope: row.scope,
        id: row.id,
        mode: row.mode,
        blockedTools: row.blockedTools,
        blockedActions: row.blockedActions,
      })),
    },
  });
  return { server: scopedView(await loadRow(input.serverId), session) };
}
