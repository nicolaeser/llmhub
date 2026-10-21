import { recordedPrisma } from "./support/recorded-prisma";
import { setRequest } from "./support/next-headers-stub";
import assert from "node:assert/strict";
import test from "node:test";
import { hasUserActions, userActions, usersWithAccessTo } from "@/app/(app)/users/_components/user-actions";
import {
  ACCESS_CHECK_GAP_MS,
  accessStale,
  deniedCode,
  noteDenied,
  receiveAccess,
  recheckAccess,
  watchAccess,
} from "@/lib/auth/access-watch";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { accessKey, effectivePermissions, OWNER_ACCESS_KEY, permissions, roleTemplates } from "@/lib/auth/permissions";
import { actionFail, isActionFail } from "@/lib/http/action-result";
import { liveAccessKeyOf } from "@/lib/updates/build-change";
import type { ActionFail } from "@/types/actions";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { ConsoleAccess } from "@/types/console";
import type { UpdaterSnapshot } from "@/types/updates";

const SNAPSHOT: UpdaterSnapshot = {
  build: { version: "v2026.10.20.abc1234", startedAt: "2026-10-20T09:00:00.000Z" },
  updater: null,
  updating: false,
};

function principal(granted: readonly Permission[], options: { isOwner?: boolean; orgId?: string | null } = {}): AuthenticatedSession {
  const isOwner = options.isOwner ?? false;
  const orgId = options.orgId ?? null;
  return {
    error: false,
    sessionId: "s1",
    user: { id: "actor", username: "actor", email: "actor@example.com", orgId } as AuthenticatedSession["user"],
    isOwner,
    role: null,
    permissions: effectivePermissions({ isOwner, rolePermissions: [...granted], orgId }),
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

function userRow(id: string, granted: readonly Permission[], options: { isOwner?: boolean } = {}) {
  return {
    id,
    username: id,
    email: `${id}@example.com`,
    roleId: `role-${id}`,
    role: { id: `role-${id}`, name: null, templateKey: null, permissions: [...granted] },
    isOwner: options.isOwner ?? false,
    blocked: false,
    orgId: null,
    org: null,
    maxBudget: 25,
    spend: 5,
    budgetDuration: "30d",
    totp: { enabledAt: new Date() },
    _count: { passkeys: 0 },
    sessions: [],
    mustChangePassword: false,
    logContent: true,
    revision: 1,
  };
}

const USERS = [
  userRow("actor", ["users:read"]),
  userRow("owner", [], { isOwner: true }),
  userRow("weak", []),
  userRow("strong", [...roleTemplates.admin]),
];

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("the access key changes with permissions and company but not with their order, and stays fixed for the owner", () => {
  const base = accessKey({ isOwner: false, orgId: null, permissions: ["users:read", "keys:read"] });
  assert.equal(base, accessKey({ isOwner: false, orgId: null, permissions: ["keys:read", "users:read"] }));
  assert.notEqual(base, accessKey({ isOwner: false, orgId: null, permissions: ["keys:read", "users:read", "users:manage"] }));
  assert.notEqual(base, accessKey({ isOwner: false, orgId: null, permissions: ["keys:read"] }));
  assert.notEqual(base, accessKey({ isOwner: false, orgId: "orgacme0001", permissions: ["users:read", "keys:read"] }));
  assert.notEqual(accessKey({ isOwner: false, orgId: null, permissions: [] }), accessKey({ isOwner: false, orgId: "o", permissions: [] }));
  assert.equal(accessKey({ isOwner: true, orgId: null, permissions: [...permissions] }), OWNER_ACCESS_KEY);
  assert.equal(accessKey({ isOwner: true, orgId: "orgacme0001", permissions: [] }), OWNER_ACCESS_KEY);
  assert.notEqual(accessKey({ isOwner: false, orgId: null, permissions: [...permissions] }), OWNER_ACCESS_KEY);
});

test("only a different, non-empty access key is stale and only permission answers trigger a check", () => {
  assert.equal(accessStale("a", "b"), true);
  assert.equal(accessStale("a", "a"), false);
  assert.equal(accessStale("a", ""), false);
  assert.equal(accessStale("a", null), false);
  assert.equal(accessStale("a", 7), false);
  for (const code of ["FORBIDDEN", "Forbidden", "PLATFORM_ONLY", "INVALID_SCOPE", "USER_PROTECTED", "ROLE_PROTECTED", "Unauthorized", "UNAUTHORIZED"]) {
    assert.equal(deniedCode(code), true, code);
  }
  for (const code of ["VALIDATION", "NOT_FOUND", "REQUEST_FAILED", "OWNER_PROTECTED", "CANNOT_SELF"]) {
    assert.equal(deniedCode(code), false, code);
  }
  assert.equal(liveAccessKeyOf({ key: "k1" }), "k1");
  for (const body of [null, "k1", {}, { key: "" }, { key: 3 }]) assert.equal(liveAccessKeyOf(body), null, JSON.stringify(body));
});

test("a refused action reloads the console only when the access key changed since the page loaded", async () => {
  let now = 1_000_000;
  let current: ConsoleAccess | ActionFail = { key: "loaded" };
  let checks = 0;
  let reloads = 0;
  const stop = watchAccess({
    key: "loaded",
    now: () => now,
    check: async () => {
      checks += 1;
      return current;
    },
    reload: () => {
      reloads += 1;
    },
  });
  try {
    assert.equal(isActionFail(actionFail("VALIDATION")), true);
    await flush();
    assert.equal(checks, 0);

    assert.equal(isActionFail(actionFail("FORBIDDEN")), true);
    isActionFail(actionFail("FORBIDDEN"));
    await flush();
    assert.equal(checks, 1);
    assert.equal(reloads, 0);

    now += ACCESS_CHECK_GAP_MS - 1;
    noteDenied("PLATFORM_ONLY");
    await flush();
    assert.equal(checks, 1);

    now += 1;
    current = { key: "changed" };
    noteDenied("PLATFORM_ONLY");
    await flush();
    assert.equal(checks, 2);
    assert.equal(reloads, 1);

    receiveAccess("other");
    now += ACCESS_CHECK_GAP_MS;
    noteDenied("FORBIDDEN");
    await flush();
    assert.equal(reloads, 1);
  } finally {
    stop();
  }

  const signedOut = watchAccess({
    key: "loaded",
    check: async () => actionFail("Unauthorized"),
    reload: () => {
      reloads += 1;
    },
  });
  try {
    recheckAccess();
    await flush();
    assert.equal(reloads, 2);
  } finally {
    signedOut();
  }

  isActionFail(actionFail("FORBIDDEN"));
  receiveAccess("changed");
  await flush();
  assert.equal(reloads, 2);
});

test("the live stream tells the console its access key on connect and again only when a recheck changes it", async () => {
  const { liveAccess, liveStream, sseEvent } = await import("@/lib/updates/live-stream");
  const abort = new AbortController();
  const keys = ["viewer", "viewer", "manager"];
  const reader = liveStream({
    sessionId: "session-access",
    access: liveAccess(["users:read"], {}, "viewer"),
    signal: abort.signal,
    heartbeatMs: 5,
    accessCheckMs: 0,
    loadSnapshot: async () => SNAPSHOT,
    checkAccess: async () => liveAccess(["users:read", "users:manage"], {}, keys.shift() ?? "manager"),
  }).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes('"manager"')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  abort.abort();
  for (;;) {
    if ((await reader.read()).done) break;
  }
  assert.ok(text.includes(sseEvent("access", JSON.stringify({ key: "viewer" }))), text);
  assert.ok(text.includes(sseEvent("access", JSON.stringify({ key: "manager" }))), text);
  assert.equal(text.split("event: access").length - 1, 2);
  assert.ok(text.indexOf("event: status") < text.indexOf("event: access"));
});

test("a read-only caller gets the console users without role, company, spend, or action data", async () => {
  const { usersConsole } = await import("@/lib/auth/users");
  recordedPrisma.reset({ user: { findMany: () => USERS } });
  const payload = await usersConsole(principal(["users:read"]));
  assert.deepEqual(payload.roles, []);
  assert.deepEqual(payload.orgs, []);
  assert.deepEqual(recordedPrisma.called("role"), []);
  assert.deepEqual(recordedPrisma.called("organization"), []);
  assert.equal(payload.canManage || payload.canSecure || payload.canBudget, false);
  assert.ok(payload.users.every((user) => user.budget === null && !user.manageable));
  assert.equal(hasUserActions(payload), false);
});

test("partial user rights show only their own row actions and never on the owner, the actor, or stronger users", async () => {
  const { usersConsole } = await import("@/lib/auth/users");
  const cases: [Permission[], string[], boolean][] = [
    [["users:read", "users:security"], ["sessions", "reset"], false],
    [["users:read", "budgets:manage"], ["budget", "boost"], true],
    [
      ["users:read", "users:manage", "keys:read"],
      ["role", "password", "content", "block", "delete"],
      false,
    ],
  ];
  for (const [granted, actions, seesSpend] of cases) {
    recordedPrisma.reset({ user: { findMany: () => USERS } });
    const payload = await usersConsole(principal(granted));
    const byId = new Map(payload.users.map((user) => [user.id, user]));
    assert.deepEqual(userActions(payload, byId.get("weak")!), actions, granted.join(","));
    for (const id of ["actor", "owner", "strong"]) assert.deepEqual(userActions(payload, byId.get(id)!), [], `${granted} ${id}`);
    assert.equal(hasUserActions(payload), actions.length > 0, granted.join(","));
    assert.equal(byId.get("weak")!.budget !== null, seesSpend, granted.join(","));
    assert.equal(recordedPrisma.called("organization").length > 0, granted.includes("users:manage"), granted.join(","));
  }
});

test("usage and log links on console users follow spend:read and spend:read-all", async () => {
  const { usersConsole } = await import("@/lib/auth/users");
  const all = ["usage", "logs"];
  const cases: [Permission[], "all" | "own" | "none", Record<string, string[]>][] = [
    [["users:read"], "none", { actor: [], owner: [], weak: [], strong: [] }],
    [["users:read", "spend:read-all"], "none", { actor: [], owner: [], weak: [], strong: [] }],
    [["users:read", "spend:read"], "own", { actor: all, owner: [], weak: [], strong: [] }],
    [["users:read", "spend:read", "spend:read-all"], "all", { actor: all, owner: all, weak: all, strong: all }],
    [
      ["users:read", "spend:read", "spend:read-all", "budgets:manage"],
      "all",
      { actor: all, owner: all, weak: [...all, "budget", "boost"], strong: all },
    ],
  ];
  for (const [granted, insights, expected] of cases) {
    recordedPrisma.reset({ user: { findMany: () => USERS } });
    const payload = await usersConsole(principal(granted));
    assert.equal(payload.insights, insights, granted.join(","));
    for (const user of payload.users) assert.deepEqual(userActions(payload, user), expected[user.id], `${granted} ${user.id}`);
    assert.equal(hasUserActions(payload), insights !== "none", granted.join(","));
  }
});

test("the console users list links companies only for tenancy readers and filters by company access", async () => {
  const { usersConsole } = await import("@/lib/auth/users");
  recordedPrisma.reset({ user: { findMany: () => USERS } });
  assert.equal((await usersConsole(principal(["users:read"]))).canSeeCompanies, false);
  recordedPrisma.reset({ user: { findMany: () => USERS } });
  assert.equal((await usersConsole(principal(["users:read", "tenancy:read"]))).canSeeCompanies, true);

  const rows = [
    { id: "a", orgId: "o1" },
    { id: "b", orgId: null },
    { id: "c", orgId: "o2" },
    { id: "d", orgId: "o1" },
  ];
  assert.deepEqual(usersWithAccessTo(rows, "o1").map((row) => row.id), ["a", "d"]);
  assert.deepEqual(usersWithAccessTo(rows, "").map((row) => row.id), ["a", "b", "c", "d"]);
  assert.deepEqual(usersWithAccessTo(rows, "missing"), []);
});

test("a temporary boost is offered only for console users with a capped budget", () => {
  const flags = { canManage: false, canSecure: false, canBudget: true, insights: "none" as const, selfId: "actor" };
  const budget = (maxBudget: number) => ({ maxBudget, spend: 1, budgetDuration: "" });
  const user = (manageable: boolean, cap: ReturnType<typeof budget> | null) => ({ id: "weak", manageable, budget: cap });
  assert.deepEqual(userActions(flags, user(true, budget(10))), ["budget", "boost"]);
  assert.deepEqual(userActions(flags, user(true, budget(0))), ["budget"]);
  assert.deepEqual(userActions(flags, user(true, null)), ["budget"]);
  assert.deepEqual(userActions({ ...flags, canBudget: false }, user(true, budget(10))), []);
  assert.deepEqual(userActions(flags, user(false, budget(10))), []);
});

test("user managers only get roles they may grant, and role managers only grantable templates and resets", async () => {
  const { usersConsole } = await import("@/lib/auth/users");
  const { loadRolesConsole } = await import("@/lib/auth/roles");
  const roles = [
    { id: "r-admin", templateKey: "admin", name: null, description: null, permissions: [...roleTemplates.admin], revision: 1, createdAt: new Date(1), _count: { users: 1 } },
    { id: "r-viewer", templateKey: "viewer", name: null, description: null, permissions: ["keys:read"], revision: 1, createdAt: new Date(2), _count: { users: 0 } },
    { id: "r-small", templateKey: null, name: "Small", description: null, permissions: ["keys:read"], revision: 1, createdAt: new Date(3), _count: { users: 0 } },
  ];
  const actor = principal(["users:read", "users:manage", "roles:manage", "keys:read"]);
  recordedPrisma.reset({ user: { findMany: () => USERS }, role: { findMany: () => roles } });
  const payload = await usersConsole(actor);
  assert.deepEqual(
    payload.roles.map((role) => [role.id, role.assignable]),
    [["r-admin", false], ["r-viewer", true], ["r-small", true]],
  );

  recordedPrisma.reset({ role: { findMany: () => roles } });
  const rolesPage = await runAsPrincipal(actor, () => loadRolesConsole());
  assert.deepEqual(rolesPage.grantable, actor.permissions);
  assert.deepEqual(rolesPage.missingTemplates, []);
  assert.deepEqual(
    rolesPage.roles.map((role) => [role.id, role.editable, role.resettable]),
    [["r-admin", false, false], ["r-viewer", true, false], ["r-small", true, false]],
  );

  const owner = principal([], { isOwner: true });
  recordedPrisma.reset({ role: { findMany: () => roles } });
  const full = await runAsPrincipal(owner, () => loadRolesConsole());
  assert.deepEqual(full.missingTemplates, ["operator", "finance"]);
  assert.deepEqual(
    full.roles.map((role) => [role.id, role.resettable]),
    [["r-admin", true], ["r-viewer", true], ["r-small", false]],
  );
});

test("the users page budget action only ever sets console user budgets and needs budgets:manage", async () => {
  const { setBudgetAction } = await import("@/app/(app)/users/_action");
  const input = { kind: "org" as const, id: "orgacme0001", maxBudget: 10, budgetDuration: "30d" };
  recordedPrisma.reset();
  assert.deepEqual(await runAsPrincipal(principal(["users:read"]), () => setBudgetAction(input)), actionFail("FORBIDDEN"));
  assert.deepEqual(recordedPrisma.calls, []);

  recordedPrisma.reset();
  assert.deepEqual(
    await runAsPrincipal(principal(["users:read", "budgets:manage"]), () => setBudgetAction(input)),
    actionFail("NOT_FOUND"),
  );
  assert.equal(recordedPrisma.called("user", "findUnique").length, 1);
  assert.deepEqual(recordedPrisma.called("organization"), []);
});

test("the users and keys pages read and boost only their own budget kind", async () => {
  const users = await import("@/app/(app)/users/_action");
  const keys = await import("@/app/(app)/keys/_action");
  const manager = principal(["users:read", "keys:read", "budgets:manage"]);
  const company = { kind: "org" as const, id: "orgacme0001" };
  const pages: [string, typeof users | typeof keys, string][] = [
    ["users", users, "user"],
    ["keys", keys, "virtualKey"],
  ];
  for (const [name, page, holder] of pages) {
    const calls: (() => Promise<unknown>)[] = [
      () => page.loadBudgetAction(company),
      () => page.setBudgetAction({ ...company, maxBudget: 10, budgetDuration: "" }),
      () => page.addBoostAction({ ...company, amount: 5, hours: 1 }),
    ];
    for (const call of calls) {
      recordedPrisma.reset();
      assert.deepEqual(await runAsPrincipal(manager, call), actionFail("NOT_FOUND"), name);
      assert.equal(recordedPrisma.called(holder, "findUnique").length, 1, name);
      assert.deepEqual(recordedPrisma.called("organization"), [], name);
    }

    recordedPrisma.reset({
      tempBudget: { findUnique: () => ({ id: "boost1", entityType: "org", entityId: company.id, amount: 5, until: new Date() }) },
    });
    assert.deepEqual(await runAsPrincipal(manager, () => page.removeBoostAction("boost1")), actionFail("NOT_FOUND"), name);
    assert.deepEqual(recordedPrisma.called("organization"), [], name);
    assert.deepEqual(recordedPrisma.called("tempBudget", "delete"), [], name);
  }
});

test("only settings readers are told about new releases", async () => {
  const { loadUpdateStatusAction } = await import("@/app/(app)/_action");
  setRequest({ cookies: { [SESSION_COOKIE]: await signSessionToken("b".repeat(64)) } });
  recordedPrisma.reset({
    session: {
      findUnique: () => ({
        id: "s1",
        expiresAt: new Date(Date.now() + 3_600_000),
        lastActive: new Date(),
        secondFactor: "TOTP",
        ipAddress: null,
        userAgent: null,
        user: { id: "u1", blocked: false, isOwner: false, orgId: null, roleId: "r1", role: { id: "r1", templateKey: "viewer", name: null, permissions: ["users:read"] } },
      }),
    },
  });
  const status = await loadUpdateStatusAction();
  assert.equal(isActionFail(status), false);
  assert.equal((status as { available: boolean }).available, false);
  assert.deepEqual(recordedPrisma.called("setting"), []);
});
