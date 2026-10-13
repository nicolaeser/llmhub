import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { deleteUser } from "@/lib/auth/users";
import { deleteScimUser } from "@/lib/auth/scim";
import { removeUserWithInternalKeys } from "@/lib/auth/user-removal";
import { closeDatabase, createUser, ownerSession, uniqueName } from "./support/database";

after(closeDatabase);

function keyData(input: { userId: string; orgId?: string; projectId?: string; memberId?: string }) {
  const hash = uniqueName("hash");
  return { ...input, hash, prefix: hash.slice(-8), keyAlias: uniqueName("key") };
}

async function fixture() {
  const org = await prisma.organization.create({ data: { alias: uniqueName("org") } });
  const project = await prisma.project.create({ data: { alias: uniqueName("project"), orgId: org.id } });
  const member = await prisma.member.create({ data: { name: uniqueName("member"), orgId: org.id } });
  const user = await createUser({ orgId: org.id });
  const internal = await prisma.virtualKey.create({ data: keyData({ userId: user.id, orgId: org.id }) });
  const projectKey = await prisma.virtualKey.create({
    data: keyData({ userId: user.id, orgId: org.id, projectId: project.id }),
  });
  const memberKey = await prisma.virtualKey.create({
    data: keyData({ userId: user.id, orgId: org.id, memberId: member.id }),
  });
  const until = new Date(Date.now() + 3_600_000);
  const boosts = await Promise.all(
    [
      { entityType: "key", entityId: internal.id },
      { entityType: "key", entityId: projectKey.id },
      { entityType: "user", entityId: user.id },
    ].map((boost) => prisma.tempBudget.create({ data: { ...boost, amount: 5, until } })),
  );
  return { org, project, member, user, internal, projectKey, memberKey, boosts };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cleanup(data: Fixture, actors: string[] = []) {
  const keyIds = [data.internal.id, data.projectKey.id, data.memberKey.id];
  await prisma.tempBudget.deleteMany({ where: { id: { in: data.boosts.map((boost) => boost.id) } } });
  await prisma.virtualKey.deleteMany({ where: { id: { in: keyIds } } });
  await prisma.gatewayAuditLog.deleteMany({ where: { objectId: data.user.id } });
  await prisma.user.deleteMany({ where: { id: { in: [data.user.id, ...actors] } } });
  await prisma.member.deleteMany({ where: { id: data.member.id } });
  await prisma.project.deleteMany({ where: { id: data.project.id } });
  await prisma.organization.deleteMany({ where: { id: data.org.id } });
}

async function remainingKeys(data: Fixture) {
  const keys = await prisma.virtualKey.findMany({
    where: { id: { in: [data.internal.id, data.projectKey.id, data.memberKey.id] } },
    select: { id: true, userId: true },
  });
  return new Map(keys.map((key) => [key.id, key.userId]));
}

test("deleting a console user revokes their internal keys and boosts and keeps project and person keys", async () => {
  const data = await fixture();
  const session = await ownerSession();
  try {
    await deleteUser(session, data.user.id);

    assert.equal(await prisma.user.findUnique({ where: { id: data.user.id } }), null);
    const keys = await remainingKeys(data);
    assert.equal(keys.has(data.internal.id), false);
    assert.equal(keys.get(data.projectKey.id), null);
    assert.equal(keys.get(data.memberKey.id), null);

    const boosts = await prisma.tempBudget.findMany({
      where: { id: { in: data.boosts.map((boost) => boost.id) } },
      select: { entityType: true, entityId: true },
    });
    assert.deepEqual(boosts, [{ entityType: "key", entityId: data.projectKey.id }]);

    const audit = await prisma.gatewayAuditLog.findFirstOrThrow({
      where: { action: "user.delete", objectId: data.user.id },
    });
    assert.equal(audit.actor, session.user.id);
    assert.deepEqual(JSON.parse(audit.afterJson), { revokedKeys: 1 });
    assert.equal(JSON.parse(audit.beforeJson).username, data.user.username);
  } finally {
    await cleanup(data, [session.user.id]);
  }
});

test("SCIM deprovisioning revokes internal keys the same way", async () => {
  const data = await fixture();
  try {
    await deleteScimUser(data.user.id);

    const keys = await remainingKeys(data);
    assert.deepEqual([...keys.keys()].sort(), [data.projectKey.id, data.memberKey.id].sort());
    const audit = await prisma.gatewayAuditLog.findFirstOrThrow({
      where: { action: "scim.user.delete", objectId: data.user.id },
    });
    assert.deepEqual(JSON.parse(audit.afterJson), { revokedKeys: 1 });
  } finally {
    await cleanup(data);
  }
});

test("key revocation rolls back when the user cannot be deleted", async () => {
  const data = await fixture();
  try {
    await prisma.user.update({ where: { id: data.user.id }, data: { isOwner: true } });

    await assert.rejects(removeUserWithInternalKeys(data.user.id));

    assert.ok(await prisma.user.findUnique({ where: { id: data.user.id } }));
    const keys = await remainingKeys(data);
    assert.equal(keys.get(data.internal.id), data.user.id);
    assert.equal(
      await prisma.tempBudget.count({ where: { id: { in: data.boosts.map((boost) => boost.id) } } }),
      data.boosts.length,
    );
  } finally {
    await cleanup(data);
  }
});
