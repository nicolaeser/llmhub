import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { setupStepsFor } from "@/app/(app)/companies/_components/tree-model";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { effectivePermissions, permissions, roleTemplates } from "@/lib/auth/permissions";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { BudgetKind } from "@/types/structure";

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
  assert.equal(tenancyOnly.canManageKeys, false);
  assert.equal(tenancyOnly.canCreateKeys, false);
  assert.equal(tenancyOnly.canMcp, false);
  assert.equal(recordedPrisma.called("virtualKey").length, 0);

  recordedPrisma.reset();
  const shown = await runAsPrincipal(viewer, () => loadStructure());
  assert.equal(shown.canSeeKeys, true);
  assert.equal(shown.canSeeMcp, true);
  assert.equal(shown.canManageKeys, false);
  assert.equal(shown.canCreateKeys, false);
  assert.equal(shown.canMcp, false);
});

test("key dialog options need keys:manage and key details keys:read before reading data", async () => {
  const { loadKeyDetail, loadKeyOptions } = await import("@/lib/keys/manage");
  recordedPrisma.reset();
  await assert.rejects(runAsPrincipal(viewer, () => loadKeyOptions()), /FORBIDDEN/);
  await assert.rejects(runAsPrincipal(principal({ permissions: ["tenancy:read"] }), () => loadKeyDetail("k1")), /FORBIDDEN/);
  assert.deepEqual(recordedPrisma.calls, []);
  await assert.rejects(runAsPrincipal(viewer, () => loadKeyDetail(" ")), /MISSING_ID/);
  await assert.rejects(runAsPrincipal(viewer, () => loadKeyDetail("missing")), /NOT_FOUND/);

  recordedPrisma.reset();
  const platform = await runAsPrincipal(owner, () => loadKeyOptions());
  assert.equal(platform.canTemplates, true);
  const company = await runAsPrincipal(companyUser, () => loadKeyOptions());
  assert.equal(company.canTemplates, false);
});

test("the company structure grants key actions with the same permissions as the API keys page", async () => {
  const { loadStructure } = await import("@/lib/tenancy/structure");
  const keyManager = principal({ permissions: ["tenancy:read", "keys:read", "keys:manage"] });
  const binder = principal({ permissions: ["tenancy:read", "tenancy:manage", "keys:read", "keys:manage"] });
  const blindManager = principal({ permissions: ["tenancy:read", "keys:manage", "tenancy:manage", "mcp:manage"] });
  const cases: [AuthenticatedSession, { manage: boolean; create: boolean; mcp: boolean }][] = [
    [keyManager, { manage: true, create: false, mcp: false }],
    [binder, { manage: true, create: true, mcp: false }],
    [blindManager, { manage: false, create: false, mcp: false }],
    [principal({ permissions: ["tenancy:read", "keys:read", "mcp:manage"] }), { manage: false, create: false, mcp: true }],
    [principal({ orgId: COMPANY_ID, permissions: ["tenancy:read", "keys:read", "mcp:install"] }), { manage: false, create: false, mcp: true }],
    [principal({ permissions: ["tenancy:read", "keys:read", "mcp:install"] }), { manage: false, create: false, mcp: false }],
    [owner, { manage: true, create: true, mcp: true }],
  ];
  for (const [session, expected] of cases) {
    recordedPrisma.reset();
    const payload = await runAsPrincipal(session, () => loadStructure());
    assert.deepEqual(
      { manage: payload.canManageKeys, create: payload.canCreateKeys, mcp: payload.canMcp },
      expected,
      session.permissions.join(","),
    );
  }
});

test("the company structure links the alert settings only for platform callers who may read settings", async () => {
  const { loadStructure } = await import("@/lib/tenancy/structure");
  const cases: [AuthenticatedSession, boolean][] = [
    [owner, true],
    [viewer, true],
    [principal({ permissions: ["tenancy:read"] }), false],
    [ownerCompanyView, false],
    [companyUser, false],
  ];
  for (const [session, linked] of cases) {
    recordedPrisma.reset();
    const payload = await runAsPrincipal(session, () => loadStructure());
    assert.equal(payload.canSeeSettings, linked);
    assert.deepEqual(payload.thresholds, [50, 80, 100]);
  }
});

test("the company structure lists console users, usage links, and policies only with their permissions", async () => {
  const { loadStructure } = await import("@/lib/tenancy/structure");
  const cases: [AuthenticatedSession, { users: boolean; usage: boolean; policies: boolean }][] = [
    [principal({ permissions: ["tenancy:read"] }), { users: false, usage: false, policies: false }],
    [principal({ permissions: ["tenancy:read", "users:read"] }), { users: true, usage: false, policies: false }],
    [principal({ permissions: ["tenancy:read", "spend:read"] }), { users: false, usage: true, policies: false }],
    [principal({ permissions: ["tenancy:read", "settings:read"] }), { users: false, usage: false, policies: true }],
    [viewer, { users: true, usage: true, policies: true }],
    [owner, { users: true, usage: true, policies: true }],
    [ownerCompanyView, { users: false, usage: true, policies: true }],
    [companyUser, { users: false, usage: true, policies: false }],
  ];
  for (const [session, expected] of cases) {
    recordedPrisma.reset();
    const payload = await runAsPrincipal(session, () => loadStructure());
    assert.deepEqual(
      { users: payload.canSeeUsers, usage: payload.canSeeUsage, policies: payload.canSeePolicies },
      expected,
      session.permissions.join(","),
    );
  }
});

test("company policy summaries need settings:read and stay inside the caller's company and key scope", async () => {
  const { loadCompanyPolicies } = await import("@/lib/settings/guardrail-policies");
  recordedPrisma.reset();
  await assert.rejects(
    runAsPrincipal(principal({ permissions: ["tenancy:read", "spend:read"] }), () => loadCompanyPolicies(COMPANY_ID)),
    /FORBIDDEN/,
  );
  await assert.rejects(runAsPrincipal(ownerCompanyView, () => loadCompanyPolicies("orgother001")), /NOT_FOUND/);
  await assert.rejects(runAsPrincipal(viewer, () => loadCompanyPolicies(" ")), /MISSING_ID/);
  assert.deepEqual(recordedPrisma.calls, []);

  recordedPrisma.reset();
  await assert.rejects(runAsPrincipal(viewer, () => loadCompanyPolicies("missing")), /NOT_FOUND/);

  recordedPrisma.reset({
    organization: { findUnique: () => ({ id: COMPANY_ID }) },
    policyOverride: {
      findMany: () => [
        {
          orgId: COMPANY_ID,
          teamId: null,
          projectId: null,
          keyId: null,
          pii: { enabled: true, mode: "block", output: false, entities: ["EMAIL_ADDRESS"] },
          injection: null,
          secrets: null,
          rules: null,
        },
        {
          orgId: null,
          teamId: null,
          projectId: "p1",
          keyId: null,
          pii: null,
          injection: { enabled: true, action: "block", checks: [] },
          secrets: null,
          rules: null,
        },
        {
          orgId: null,
          teamId: null,
          projectId: null,
          keyId: "k1",
          pii: { enabled: false, mode: "mask", output: false, entities: [] },
          injection: null,
          secrets: null,
          rules: [],
        },
      ],
    },
    team: { findMany: () => [{ id: "t1", alias: "Ops" }] },
    project: {
      findMany: () => [
        { id: "p1", alias: "Bot" },
        { id: "p2", alias: "Plain" },
      ],
    },
    virtualKey: { findMany: () => [{ id: "k1", keyAlias: "", prefix: "sk-hub-k1" }] },
  });
  const summary = await runAsPrincipal(viewer, () => loadCompanyPolicies(COMPANY_ID));
  assert.deepEqual(
    summary.sections.map((row) => [row.section, row.state, row.level]),
    [
      ["pii", "block", "org"],
      ["injection", "off", "global"],
      ["secrets", "off", "global"],
      ["rules", "off", "global"],
    ],
  );
  assert.equal(summary.sections[0]?.count, 1);
  assert.deepEqual(
    summary.overrides.map((row) => [row.scope, row.id, row.alias, row.sections]),
    [
      ["project", "p1", "Bot", [{ section: "injection", state: "block", count: 0 }]],
      [
        "key",
        "k1",
        "sk-hub-k1",
        [
          { section: "pii", state: "off", count: 0 },
          { section: "rules", state: "off", count: 0 },
        ],
      ],
    ],
  );
  assert.deepEqual((recordedPrisma.called("policyOverride", "findMany")[0]?.args as { where: unknown }).where, {
    OR: [{ orgId: COMPANY_ID }, { team: { orgId: COMPANY_ID } }, { project: { orgId: COMPANY_ID } }, { key: { orgId: COMPANY_ID } }],
  });
  assert.deepEqual((recordedPrisma.called("team", "findMany")[0]?.args as { where: unknown }).where, { orgId: COMPANY_ID });
  assert.deepEqual((recordedPrisma.called("project", "findMany")[0]?.args as { where: unknown }).where, { orgId: COMPANY_ID });
  assert.deepEqual((recordedPrisma.called("virtualKey", "findMany")[0]?.args as { where: unknown }).where, {
    userId: "u1",
    orgId: COMPANY_ID,
  });
  assert.equal(JSON.stringify(summary).includes("EMAIL_ADDRESS"), false);
});

test("budget details need budgets:manage and keep console users in the platform scope before reading data", async () => {
  const { loadBudget } = await import("@/lib/tenancy/budgets");
  recordedPrisma.reset();
  await assert.rejects(runAsPrincipal(viewer, () => loadBudget({ kind: "team", id: "t1" })), /FORBIDDEN/);
  await assert.rejects(runAsPrincipal(ownerCompanyView, () => loadBudget({ kind: "user", id: "u2" })), /PLATFORM_ONLY/);
  await assert.rejects(runAsPrincipal(companyUser, () => loadBudget({ kind: "org", id: COMPANY_ID })), /PLATFORM_ONLY/);
  assert.deepEqual(recordedPrisma.calls, []);
  await assert.rejects(
    runAsPrincipal(owner, () => loadBudget({ kind: "nope" as BudgetKind, id: "x" })),
    /UNKNOWN_ENTITY_TYPE/,
  );
  await assert.rejects(runAsPrincipal(owner, () => loadBudget({ kind: "team", id: " " })), /MISSING_ID/);
  await assert.rejects(runAsPrincipal(owner, () => loadBudget({ kind: "team", id: "missing" })), /NOT_FOUND/);
});

test("read-only knowledge and guardrail views leave out what only editing needs", async () => {
  const { loadKnowledge } = await import("@/lib/rag/knowledge");
  const { loadGuardrails } = await import("@/lib/settings/guardrail-policies");
  recordedPrisma.reset();
  const knowledge = await runAsPrincipal(viewer, () => loadKnowledge());
  assert.equal(knowledge.canManage, false);
  assert.deepEqual(knowledge.models, []);
  assert.equal(recordedPrisma.called("modelGroup").length, 0);

  recordedPrisma.reset({ organization: { findMany: () => [{ id: COMPANY_ID, alias: "Acme" }] } });
  const guardrails = await runAsPrincipal(viewer, () => loadGuardrails());
  assert.equal(guardrails.canManage, false);
  assert.deepEqual(guardrails.targets, []);

  recordedPrisma.reset({ organization: { findMany: () => [{ id: COMPANY_ID, alias: "Acme" }] } });
  const managed = await runAsPrincipal(owner, () => loadGuardrails());
  assert.equal(managed.targets.length, 1);
});
