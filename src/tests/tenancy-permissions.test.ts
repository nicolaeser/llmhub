import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { setupStepsFor } from "@/app/(app)/companies/_components/tree-model";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { effectivePermissions, permissions, roleTemplates } from "@/lib/auth/permissions";
import type { AuthenticatedSession, Permission } from "@/types/auth";

const COMPANY_ID = "orgacme0001";

function principal(
  options: { isOwner?: boolean; orgId?: string | null; workspaceOrgId?: string | null; permissions?: readonly Permission[] } = {},
): AuthenticatedSession {
  const isOwner = options.isOwner ?? false;
  const orgId = options.orgId ?? null;
  return {
    error: false,
    sessionId: "s1",
    user: { id: "u1", username: "someone", email: "someone@example.com", orgId } as AuthenticatedSession["user"],
    isOwner,
    role: null,
    permissions: effectivePermissions({ isOwner, rolePermissions: options.permissions ?? [], orgId }),
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
    workspaceOrgId: options.workspaceOrgId ?? null,
  };
}

const owner = principal({ isOwner: true });
const ownerCompanyView = principal({ isOwner: true, workspaceOrgId: COMPANY_ID });
const viewer = principal({ permissions: roleTemplates.viewer });
const operator = principal({ permissions: roleTemplates.operator });
const mcpManager = principal({ permissions: ["mcp:read", "mcp:manage"] });
const companyUser = principal({ orgId: COMPANY_ID, permissions: permissions });

test("MCP access flags follow the permission and keep server management in the platform scope", async () => {
  const { mcpAccess } = await import("@/lib/mcp/scope");
  assert.deepEqual(mcpAccess(viewer, null), { canManage: false, canInstall: false, canAssign: false });
  assert.deepEqual(mcpAccess(operator, null), { canManage: false, canInstall: true, canAssign: false });
  assert.deepEqual(mcpAccess(mcpManager, null), { canManage: true, canInstall: true, canAssign: true });
  assert.deepEqual(mcpAccess(owner, null), { canManage: true, canInstall: true, canAssign: true });
  assert.deepEqual(mcpAccess(ownerCompanyView, COMPANY_ID), { canManage: false, canInstall: true, canAssign: true });
  assert.deepEqual(mcpAccess(companyUser, COMPANY_ID), { canManage: false, canInstall: true, canAssign: true });
});

test("MCP server changes refuse the company scope and callers without a manage permission before reading data", async () => {
  const servers = await import("@/lib/mcp/servers");
  const catalog = await import("@/lib/mcp/catalog");
  const probe = await import("@/lib/mcp/server-probe");
  const oauth = await import("@/lib/mcp/server-oauth");
  const builder = await import("@/lib/mcp/builder");
  const guarded: [string, () => Promise<unknown>][] = [
    ["createMcpServer", () => servers.createMcpServer({})],
    ["createHostedMcpServer", () => servers.createHostedMcpServer({})],
    ["updateMcpServer", () => servers.updateMcpServer({ id: "srv1" })],
    ["setMcpServerEnabled", () => servers.setMcpServerEnabled({ id: "srv1", enabled: false })],
    ["deleteMcpServer", () => servers.deleteMcpServer("srv1")],
    ["probeMcpServer", () => probe.probeMcpServer({})],
    ["refreshMcpServer", () => probe.refreshMcpServer("srv1")],
    ["startMcpOAuth", () => oauth.startMcpOAuth("srv1")],
    ["completeMcpOAuth", () => oauth.completeMcpOAuth({})],
    ["disconnectMcpOAuth", () => oauth.disconnectMcpOAuth("srv1")],
    ["setBuilderModel", () => builder.setBuilderModel("")],
    ["draftMcpServer", () => builder.draftMcpServer({})],
    ["ensureMcpRoles", () => catalog.ensureMcpRoles("srv1")],
    ["saveMcpPermissions", () => catalog.saveMcpPermissions({})],
    ["setMcpTemplate", () => catalog.setMcpTemplate({})],
  ];
  for (const [name, call] of guarded) {
    recordedPrisma.reset();
    await assert.rejects(runAsPrincipal(ownerCompanyView, call), /PLATFORM_ONLY/, name);
    await assert.rejects(runAsPrincipal(operator, call), /FORBIDDEN/, name);
    await assert.rejects(runAsPrincipal(companyUser, call), /FORBIDDEN/, name);
    assert.deepEqual(recordedPrisma.calls, [], name);
  }
  recordedPrisma.reset();
  await assert.rejects(runAsPrincipal(mcpManager, () => servers.deleteMcpServer("srv1")), /NOT_FOUND/);
  assert.equal(recordedPrisma.called("mcpServer", "findUnique").length, 1);
});

test("company access rules only touch servers the company can see", async () => {
  const { saveMcpAssignments } = await import("@/lib/mcp/servers");
  recordedPrisma.reset({ mcpServer: { count: () => 0 } });
  await assert.rejects(
    runAsPrincipal(companyUser, () =>
      saveMcpAssignments({
        serverId: "private1",
        global: false,
        assignments: [{ scope: "org", id: COMPANY_ID, mode: "allow", blockedTools: [] }],
      }),
    ),
    /NOT_FOUND/,
  );
  const [visibility] = recordedPrisma.called("mcpServer", "count");
  assert.equal(JSON.stringify(visibility?.args).includes(COMPANY_ID), true);
  assert.equal(recordedPrisma.called("mcpAssignment").length, 0);
});

test("the MCP page loads builder models and companies only for callers who use them", async () => {
  const { loadMcpServerList } = await import("@/lib/mcp/servers");
  recordedPrisma.reset();
  const view = await runAsPrincipal(viewer, () => loadMcpServerList());
  assert.equal(view.canManage, false);
  assert.equal(view.canAssign, false);
  assert.deepEqual(view.models, []);
  assert.deepEqual(view.companies, []);
  assert.equal(view.redirectUri, "");
  assert.equal(recordedPrisma.called("setting").length + recordedPrisma.called("modelGroup").length, 0);
  assert.equal(recordedPrisma.called("organization").length, 0);

  recordedPrisma.reset();
  const companyView = await runAsPrincipal(ownerCompanyView, () => loadMcpServerList());
  assert.equal(companyView.canManage, false);
  assert.equal(companyView.canInstall, true);
  assert.equal(recordedPrisma.called("modelGroup").length, 0);
});

test("the setup checklist skips the company step in the company scope and the budget step without budgets:manage", () => {
  assert.deepEqual(setupStepsFor({ company: false, canBudget: true }), ["org", "team", "project", "member", "budget"]);
  assert.deepEqual(setupStepsFor({ company: true, canBudget: true }), ["team", "project", "member", "budget"]);
  assert.deepEqual(setupStepsFor({ company: false, canBudget: false }), ["org", "team", "project", "member"]);
  assert.deepEqual(setupStepsFor({ company: true, canBudget: false }), ["team", "project", "member"]);
});

test("the company structure hides keys and MCP for callers who may not read them", async () => {
  const { loadStructure } = await import("@/lib/tenancy/structure");
  recordedPrisma.reset();
  const tenancyOnly = await runAsPrincipal(principal({ permissions: ["tenancy:read"] }), () => loadStructure());
  assert.equal(tenancyOnly.canSeeKeys, false);
  assert.equal(tenancyOnly.canSeeMcp, false);
  assert.equal(tenancyOnly.canManage, false);
  assert.equal(tenancyOnly.canBudget, false);
  assert.equal(recordedPrisma.called("virtualKey").length, 0);

  recordedPrisma.reset();
  const shown = await runAsPrincipal(viewer, () => loadStructure());
  assert.equal(shown.canSeeKeys, true);
  assert.equal(shown.canSeeMcp, true);
});

test("read-only knowledge and guardrail views leave out what only editing needs", async () => {
  const { loadKnowledge } = await import("@/lib/rag/knowledge");
  const { loadGuardrails } = await import("@/lib/settings/guardrail-policies");
  recordedPrisma.reset();
  const knowledge = await runAsPrincipal(viewer, () => loadKnowledge());
  assert.equal(knowledge.canManage, false);
  assert.deepEqual(knowledge.models, []);
  assert.equal(recordedPrisma.called("modelGroup").length, 0);

  recordedPrisma.reset({ organization: { findMany: () => [{ id: COMPANY_ID, alias: "Acme", piiPolicy: null, guardrailPolicy: null }] } });
  const guardrails = await runAsPrincipal(viewer, () => loadGuardrails());
  assert.equal(guardrails.canManage, false);
  assert.deepEqual(guardrails.targets, []);

  recordedPrisma.reset({ organization: { findMany: () => [{ id: COMPANY_ID, alias: "Acme", piiPolicy: null, guardrailPolicy: null }] } });
  const managed = await runAsPrincipal(owner, () => loadGuardrails());
  assert.equal(managed.targets.length, 1);
});
