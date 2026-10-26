import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { permissions } from "@/lib/auth/permissions";
import type { AuthenticatedSession, Permission } from "@/types/auth";

const COMPANY_ID = "orgacme0001";

function principal(
  granted: readonly Permission[],
  options: { isOwner?: boolean; orgId?: string | null; workspaceOrgId?: string | null } = {},
): AuthenticatedSession {
  return {
    error: false,
    sessionId: "s1",
    user: { id: "u-self", username: "analyst", email: "analyst@example.com", orgId: options.orgId ?? null } as AuthenticatedSession["user"],
    isOwner: options.isOwner ?? false,
    role: null,
    permissions: [...granted],
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
    workspaceOrgId: options.workspaceOrgId ?? null,
  };
}

const owner = principal(permissions, { isOwner: true });
const ownerCompanyView = principal(permissions, { isOwner: true, workspaceOrgId: COMPANY_ID });

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "k1",
    hash: "hash",
    prefix: "sk-hub-abcde",
    keyAlias: "bot",
    userId: "u-other",
    teamId: "t1",
    orgId: "o1",
    projectId: "p1",
    memberId: null,
    models: [],
    maxBudget: 0,
    spend: 0,
    rpmLimit: 0,
    tpmLimit: 0,
    maxRequestCost: 0,
    budgetDuration: "",
    expiresAt: null,
    allowedIps: [],
    allowedEndpoints: [],
    accessWindows: [],
    accessTimeZone: "UTC",
    blocked: false,
    logContent: true,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    templates: [],
    ...overrides,
  };
}

function whereOf(model: string, method = "findMany"): unknown {
  const call = recordedPrisma.called(model, method)[0];
  assert.ok(call, `${model}.${method}`);
  return (call.args as { where?: unknown }).where;
}

test("model templates are global and refuse the company scope before reading data", async () => {
  const { createTemplate, deleteTemplate, loadTemplates, updateTemplate } = await import("@/lib/models/templates");
  const draft = { name: "eu", description: "", models: ["gpt-4o"] };
  const guarded: [string, () => Promise<unknown>][] = [
    ["loadTemplates", () => loadTemplates()],
    ["createTemplate", () => createTemplate(draft)],
    ["updateTemplate", () => updateTemplate({ ...draft, id: "tpl-1" })],
    ["deleteTemplate", () => deleteTemplate("tpl-1")],
  ];
  for (const [name, call] of guarded) {
    recordedPrisma.reset();
    await assert.rejects(runAsPrincipal(ownerCompanyView, call), /PLATFORM_ONLY/, name);
    assert.deepEqual(recordedPrisma.calls, [], name);
  }
  recordedPrisma.reset();
  await assert.rejects(runAsPrincipal(principal(["models:read"]), () => createTemplate(draft)), /FORBIDDEN/);
  assert.equal((await runAsPrincipal(principal(["models:read"]), () => loadTemplates())).canManage, false);
});

test("unbinding a project key needs tenancy:manage like binding it does", async () => {
  const { updateKey } = await import("@/lib/keys/manage");
  const keyManager: Permission[] = ["keys:read", "keys:read-all", "keys:manage"];
  const project = { id: "p1", orgId: "o1", teamId: "t1" };
  const handlers = () => ({
    virtualKey: {
      findUnique: () => keyRow(),
      update: (args: never) => keyRow({ ...(args as { data: Record<string, unknown> }).data, templates: [] }),
    },
    project: { findUnique: () => project },
  });

  recordedPrisma.reset(handlers());
  await assert.rejects(
    runAsPrincipal(principal(keyManager), () => updateKey({ id: "k1", alias: "bot", blocked: false })),
    /FORBIDDEN/,
  );
  assert.equal(recordedPrisma.called("virtualKey", "update").length, 0);

  recordedPrisma.reset(handlers());
  const kept = await runAsPrincipal(principal(keyManager), () =>
    updateKey({ id: "k1", alias: "renamed", projectId: "p1", blocked: false }),
  );
  assert.equal(kept.key.project_id, "p1");
  assert.equal(kept.key.user_id, "u-other");

  recordedPrisma.reset(handlers());
  const moved = await runAsPrincipal(principal([...keyManager, "tenancy:manage"]), () =>
    updateKey({ id: "k1", alias: "bot", blocked: false }),
  );
  assert.equal(moved.key.project_id, "");
  assert.equal(moved.key.user_id, "u-self");
});

test("the keys page names only the tenants and owners of visible keys without tenancy access", async () => {
  const { loadKeysPage } = await import("@/lib/keys/manage");
  const visible = keyRow({ userId: "u-self", memberId: null });
  recordedPrisma.reset({ virtualKey: { findMany: () => [visible] } });
  const reader = await runAsPrincipal(principal(["keys:read"]), () => loadKeysPage());
  assert.deepEqual(whereOf("virtualKey"), { userId: "u-self" });
  assert.deepEqual(whereOf("organization"), { id: { in: ["o1"] } });
  assert.deepEqual(whereOf("team"), { id: { in: ["t1"] } });
  assert.deepEqual(whereOf("project"), { id: { in: ["p1"] } });
  assert.deepEqual(whereOf("member"), { id: { in: [] } });
  assert.deepEqual(whereOf("user"), { id: { in: ["u-self"] } });
  assert.equal(recordedPrisma.called("usageDaily").length, 0);
  assert.equal(reader.overview, null);
  assert.equal(reader.canTemplates, false);
  assert.deepEqual(reader.setupLinks, { provider: false, model: false });

  recordedPrisma.reset({ virtualKey: { findMany: () => [visible] } });
  const viewer = await runAsPrincipal(
    principal(["keys:read", "tenancy:read", "spend:read", "providers:read", "models:read"]),
    () => loadKeysPage(),
  );
  assert.deepEqual(whereOf("organization"), {});
  assert.deepEqual(whereOf("member"), {});
  assert.deepEqual(whereOf("user"), { id: { in: ["u-self"] } });
  const { day, ...spendScope } = whereOf("usageDaily", "aggregate") as Record<string, unknown>;
  assert.ok(day);
  assert.deepEqual(spendScope, { userId: "u-self" });
  assert.deepEqual(viewer.overview, { spend7d: 0, requests7d: 0, errors7d: 0 });
  assert.equal(viewer.canTemplates, true);
  assert.deepEqual(viewer.setupLinks, { provider: true, model: true });

  recordedPrisma.reset({ virtualKey: { findMany: () => [] } });
  const company = await runAsPrincipal(principal(["keys:read"], { orgId: COMPANY_ID }), () => loadKeysPage());
  assert.deepEqual(whereOf("organization"), { id: COMPANY_ID });
  assert.deepEqual(whereOf("project"), { orgId: COMPANY_ID, id: { in: [] } });
  assert.deepEqual(whereOf("user"), { orgId: COMPANY_ID, id: { in: ["u-self"] } });
  assert.equal(company.companyId, COMPANY_ID);
});

test("key references collect the tenants and owners that visible keys point at", async () => {
  const { keyReferences, toKeyView } = await import("@/lib/keys/view");
  const view = (overrides: Record<string, unknown>) =>
    toKeyView(keyRow(overrides) as unknown as Parameters<typeof toKeyView>[0]);
  const keys = [
    view({ id: "k1", userId: "u1", projectId: "p1", teamId: "t1", orgId: "o1" }),
    view({ id: "k2", userId: "u1", projectId: null, memberId: "m1", teamId: "t1", orgId: "o1" }),
    view({ id: "k3", userId: "u2", projectId: null, teamId: null, orgId: null }),
  ];
  assert.deepEqual(keyReferences(keys, "u-self"), {
    orgs: ["o1"],
    teams: ["t1"],
    projects: ["p1"],
    members: ["m1"],
    users: ["u-self", "u1", "u2"],
  });
  assert.deepEqual(keyReferences([], "u-self").users, ["u-self"]);
});

test("playground setup links point only at pages the caller can open", async () => {
  const { setupLinks } = await import("@/lib/auth/scope");
  const { loadAliases } = await import("@/lib/models/aliases");
  assert.deepEqual(setupLinks(owner), { provider: true, model: true });
  assert.deepEqual(setupLinks(ownerCompanyView), { provider: false, model: false });
  assert.deepEqual(setupLinks(principal(["playground:use", "models:read"])), { provider: false, model: true });
  assert.deepEqual(setupLinks(principal(["providers:read", "models:read"], { orgId: COMPANY_ID })), {
    provider: false,
    model: false,
  });
  recordedPrisma.reset();
  const company = await runAsPrincipal(principal(["playground:use"], { orgId: COMPANY_ID }), () => loadAliases());
  assert.deepEqual(company, { models: [], providers: 0, setupLinks: { provider: false, model: false } });
});
