import assert from "node:assert/strict";
import test from "node:test";
import {
  effectivePermissions,
  hasPerm,
  isSubset,
  permissionCatalog,
  permissionList,
  permissions,
  permissionsByDomain,
  PERMISSIONS,
  roleTemplates,
  sortPermissions,
} from "@/lib/auth/permissions";
import { canGrant, canManage, grantActor } from "@/lib/auth/grants";
import { keyVisibleTo, seesAllResources, seesAllSpend } from "@/lib/auth/scope";
import type { AuthenticatedSession, Permission } from "@/types/auth";

function session(perms: readonly Permission[], isOwner = false): AuthenticatedSession {
  return {
    error: false,
    sessionId: "s1",
    user: { id: "u1" } as AuthenticatedSession["user"],
    isOwner,
    role: null,
    permissions: effectivePermissions({ isOwner, rolePermissions: [...perms] }),
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

test("every permission has a domain and level", () => {
  for (const permission of permissions) {
    assert.ok(permissionCatalog[permission].domain, permission);
    assert.ok(permissionCatalog[permission].level, permission);
  }
  assert.equal(
    permissionsByDomain().reduce((sum, group) => sum + group.permissions.length, 0),
    permissions.length,
  );
});

test("role templates only contain catalog permissions", () => {
  for (const [key, list] of Object.entries(roleTemplates)) {
    assert.deepEqual(permissionList([...list]), [...list], key);
  }
  assert.deepEqual([...roleTemplates.admin], permissions);
});

test("operator cannot manage roles, settings, or user security", () => {
  for (const permission of ["roles:manage", "settings:manage", "users:security"] as const) {
    assert.equal(roleTemplates.operator.includes(permission), false, permission);
  }
  assert.equal(roleTemplates.operator.includes("users:manage"), true);
  assert.equal(roleTemplates.operator.includes("keys:read-all"), true);
});

test("only admins read stored request content by default", () => {
  assert.equal(permissionCatalog["logs:content"].level, "sensitive");
  assert.equal(roleTemplates.admin.includes("logs:content"), true);
  for (const key of ["operator", "finance", "viewer"] as const) {
    assert.equal(roleTemplates[key].includes("logs:content"), false, key);
  }
});

test("finance sees all spend without managing keys or settings", () => {
  const finance = roleTemplates.finance;
  assert.equal(finance.includes("spend:read-all"), true);
  assert.equal(finance.includes("keys:manage"), false);
  assert.equal(finance.includes("settings:manage"), false);
  assert.equal(finance.includes("keys:read-all"), false);
  assert.equal(finance.includes("playground:use"), false);
});

test("viewer is read-only plus playground and assistant", () => {
  const viewer = roleTemplates.viewer;
  for (const permission of viewer) {
    const meta = permissionCatalog[permission];
    assert.ok(meta.level === "view" || meta.domain === "tools", permission);
  }
  assert.equal(viewer.includes("roles:manage"), false);
});

test("unknown permissions are dropped and order follows the catalog", () => {
  assert.deepEqual(permissionList(["roles:manage", "nope", "keys:read", 42]), ["keys:read", "roles:manage"]);
  assert.deepEqual(sortPermissions(["settings:read", "keys:read"]), ["keys:read", "settings:read"]);
  assert.deepEqual(permissionList("keys:read"), []);
});

test("the owner holds every permission regardless of role", () => {
  assert.deepEqual(effectivePermissions({ isOwner: true, rolePermissions: [] }), permissions);
  assert.deepEqual(effectivePermissions({ isOwner: false, rolePermissions: null }), []);
});

test("nobody grants or manages beyond their own permissions", () => {
  const operator = grantActor(session(roleTemplates.operator));
  assert.equal(canGrant(operator, roleTemplates.viewer), true);
  assert.equal(canGrant(operator, roleTemplates.admin), false);
  assert.equal(canManage(operator, roleTemplates.finance), true);
  assert.equal(canManage(operator, roleTemplates.admin), false);
  const owner = grantActor(session([], true));
  assert.equal(canGrant(owner, roleTemplates.admin), true);
  assert.equal(isSubset(["keys:read"], ["keys:read", "keys:manage"]), true);
  assert.equal(isSubset(["roles:manage"], ["keys:read"]), false);
});

test("visibility follows permissions, not role names", () => {
  const viewer = session(roleTemplates.viewer);
  const finance = session(roleTemplates.finance);
  const operator = session(roleTemplates.operator);
  assert.equal(seesAllResources(viewer), false);
  assert.equal(seesAllResources(operator), true);
  assert.equal(seesAllSpend(finance), true);
  assert.equal(seesAllSpend(viewer), false);
  assert.equal(keyVisibleTo(viewer, "u1"), true);
  assert.equal(keyVisibleTo(viewer, "u2"), false);
  assert.equal(keyVisibleTo(operator, "u2"), true);
  assert.equal(hasPerm(viewer.permissions, PERMISSIONS.ASSISTANT_USE), true);
});
