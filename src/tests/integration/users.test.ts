import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { roleTemplates } from "@/lib/auth/permissions";
import { createUser, deleteUser, setUserBlocked, setUserContentLogging } from "@/lib/auth/users";
import {
  createRoleAction,
  createUserAction,
  deleteRoleAction,
  deleteUserAction,
  loadConsoleUsersAction,
  loadRolesAction,
  resetUserTwoFactorAction,
  revokeUserSessionsAction,
  setUserBlockedAction,
} from "@/app/(app)/users/_action";
import type { Permission } from "@/types/auth";
import { closeDatabase, uniqueName } from "./support/database";
import { sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

const authError = (code: string) => (err: unknown) => err instanceof AuthError && err.code === code;
const OPERATOR = [...roleTemplates.operator];

async function roleWith(permissions: readonly Permission[]) {
  return prisma.role.create({ data: { name: uniqueName("role"), permissions: [...permissions] } });
}

async function openSession(userId: string) {
  return prisma.session.create({
    data: { userId, tokenHash: uniqueName("token"), secondFactor: "TOTP", expiresAt: new Date(Date.now() + 86_400_000) },
  });
}

test("console user changes protect the owner, the actor, and stronger accounts", async () => {
  const data = new TestData();
  const roles: string[] = [];
  try {
    const actorUser = await data.user();
    const actor = sessionOf(actorUser, { permissions: OPERATOR });
    const owner = await data.user({ isOwner: true });
    const stronger = await data.user();
    const strongerRole = await roleWith(roleTemplates.admin);
    roles.push(strongerRole.id);
    await prisma.user.update({ where: { id: stronger.id }, data: { roleId: strongerRole.id } });
    const peer = await data.user();
    await openSession(peer.id);

    for (const [target, code] of [
      [owner.id, "OWNER_PROTECTED"],
      [actorUser.id, "CANNOT_SELF"],
      [stronger.id, "USER_PROTECTED"],
    ] as const) {
      await assert.rejects(setUserBlocked(actor, target, true), authError(code), code);
      await assert.rejects(setUserContentLogging(actor, target, false), authError(code), code);
      await assert.rejects(deleteUser(actor, target), authError(code), code);
    }
    assert.equal(await prisma.user.count({ where: { id: { in: [owner.id, actorUser.id, stronger.id] }, blocked: false } }), 3);

    await setUserBlocked(actor, peer.id, true);
    const blocked = await prisma.user.findUniqueOrThrow({ where: { id: peer.id } });
    assert.equal(blocked.blocked, true);
    assert.equal(await prisma.session.count({ where: { userId: peer.id } }), 0);
    assert.equal(await prisma.userSecurityEvent.count({ where: { userId: peer.id, action: "account.blocked" } }), 1);
  } finally {
    await data.cleanup();
    await prisma.role.deleteMany({ where: { id: { in: roles } } });
  }
});

test("new console users get only roles within the actor's permissions and unique names", async () => {
  const data = new TestData();
  const roles: string[] = [];
  try {
    const actor = sessionOf(await data.user(), { permissions: OPERATOR });
    const existing = await data.user();
    const allowed = await roleWith(["keys:read", "spend:read"]);
    const beyond = await roleWith(["keys:read", "roles:manage"]);
    roles.push(allowed.id, beyond.id);
    const input = (overrides: Record<string, unknown> = {}) => {
      const username = uniqueName("new");
      return { username, email: `${username}@example.test`, password: "Brand-new-pass-5150", roleId: allowed.id, ...overrides };
    };

    await assert.rejects(createUser(actor, input({ roleId: beyond.id })), authError("INVALID_SCOPE"));
    await assert.rejects(createUser(actor, input({ email: existing.email })), authError("USER_EXISTS"));
    await assert.rejects(createUser(actor, input({ username: existing.username })), authError("USER_EXISTS"));

    const fresh = input();
    const { id } = await createUser(actor, fresh);
    data.ownUser(id);
    const created = await prisma.user.findUniqueOrThrow({ where: { id } });
    assert.equal(created.roleId, allowed.id);
    assert.equal(created.mustChangePassword, true);
    assert.equal(created.isOwner, false);
  } finally {
    await data.cleanup();
    await prisma.role.deleteMany({ where: { id: { in: roles } } });
  }
});

test("console user actions need users:manage, and security actions need users:security", async () => {
  const data = new TestData();
  try {
    const target = await data.user();
    await openSession(target.id);
    const reader = sessionOf(await data.user(), { permissions: ["users:read"] });
    const manager = sessionOf(await data.user(), { permissions: ["users:read", "users:manage"] });
    const nobody = sessionOf(await data.user(), { permissions: [] });
    const forbidden = { ok: false, error: "FORBIDDEN", message: "FORBIDDEN" };

    assert.deepEqual(await runAsPrincipal(nobody, () => loadConsoleUsersAction()), forbidden);
    const managerCalls: (() => Promise<unknown>)[] = [
      () => createUserAction({}),
      () => deleteUserAction(target.id),
      () => setUserBlockedAction(target.id, true),
    ];
    for (const call of managerCalls) {
      assert.deepEqual(await runAsPrincipal(reader, call), forbidden);
    }
    const securityCalls: (() => Promise<unknown>)[] = [
      () => resetUserTwoFactorAction({ userId: target.id, code: "123456" }),
      () => revokeUserSessionsAction(target.id),
    ];
    for (const call of securityCalls) {
      assert.deepEqual(await runAsPrincipal(manager, call), forbidden);
    }
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).blocked, false);
    assert.equal(await prisma.session.count({ where: { userId: target.id } }), 1);

    const security = sessionOf(await data.user(), { permissions: ["users:read", "users:security"] });
    const revoked = await runAsPrincipal(security, () => revokeUserSessionsAction(target.id));
    assert.equal("users" in revoked && Array.isArray(revoked.users), true);
    assert.equal(await prisma.session.count({ where: { userId: target.id } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("role management needs roles:manage and cannot grant beyond the actor", async () => {
  const data = new TestData();
  const name = uniqueName("role");
  try {
    const usersAdmin = sessionOf(await data.user(), { permissions: ["users:read", "users:manage"] });
    const forbidden = { ok: false, error: "FORBIDDEN", message: "FORBIDDEN" };
    assert.deepEqual(await runAsPrincipal(usersAdmin, () => loadRolesAction()), forbidden);
    assert.deepEqual(
      await runAsPrincipal(usersAdmin, () => createRoleAction({ name, description: null, permissions: ["keys:read"] })),
      forbidden,
    );

    const rolesAdmin = sessionOf(await data.user(), { permissions: ["roles:manage", "keys:read"] });
    const beyond = await runAsPrincipal(rolesAdmin, () =>
      createRoleAction({ name, description: null, permissions: ["keys:read", "settings:manage"] }),
    );
    assert.deepEqual(beyond, { ok: false, error: "INVALID_SCOPE", message: "INVALID_SCOPE" });
    assert.equal(await prisma.role.count({ where: { name } }), 0);

    const created = await runAsPrincipal(rolesAdmin, () =>
      createRoleAction({ name, description: null, permissions: ["keys:read"] }),
    );
    assert.ok("role" in created);
    assert.deepEqual(created.role.permissions, ["keys:read"]);
    assert.deepEqual(await runAsPrincipal(usersAdmin, () => deleteRoleAction(created.role.id)), forbidden);
    assert.deepEqual(await runAsPrincipal(rolesAdmin, () => deleteRoleAction(created.role.id)), { id: created.role.id });
  } finally {
    await data.cleanup();
    await prisma.role.deleteMany({ where: { name } });
  }
});
