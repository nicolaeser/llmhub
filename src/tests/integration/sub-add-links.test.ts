import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { loginData } from "@/lib/gateway/upstreams/credentials";
import { deleteProvider, loadProviders } from "@/lib/providers/connections";
import { deleteSubAddLink, loadSubAddLinks } from "@/lib/providers/sub-add-links";
import { pruneSubAddLinks } from "@/lib/providers/sub-add-prune";
import { newSubAddToken, removeSubAddAccount, storeSubAddAccount } from "@/lib/providers/sub-add-store";
import type { SignInSession } from "@/types/providers";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";

after(closeDatabase);

const DAY_MS = 24 * 60 * 60 * 1000;

function session(account: string, accountId = account): SignInSession {
  return {
    tokens: { access: `access-${account}`, refresh: `refresh-${account}`, accountId: `id-${accountId}`, residency: "" },
    expiresAt: Date.now() + 3_600_000,
    account,
    plan: "max",
  };
}

async function createLink(
  data: { maxAccounts: number | null; added?: number; restricted?: boolean; orgId?: string; expiresAt?: Date },
) {
  return prisma.subAddLink.create({
    data: {
      label: uniqueName("link"),
      tokenHash: newSubAddToken().hash,
      kinds: ["claude"],
      maxAccounts: data.maxAccounts,
      added: data.added ?? 0,
      restricted: data.restricted ?? false,
      expiresAt: data.expiresAt ?? new Date(Date.now() + DAY_MS),
      ...(data.orgId ? { targets: { create: [{ orgId: data.orgId }] } } : {}),
    },
  });
}

async function cleanup(linkIds: string[], providerIds: string[] = []) {
  const accounts = await prisma.subAddAccount.findMany({ where: { linkId: { in: linkIds } }, select: { providerId: true } });
  await prisma.providerConnection.deleteMany({
    where: { id: { in: [...providerIds, ...accounts.map((row) => row.providerId)] } },
  });
  await prisma.subAddLink.deleteMany({ where: { id: { in: linkIds } } });
}

async function consoleConnection(account: string) {
  return prisma.providerConnection.create({
    data: {
      name: uniqueName("claude"),
      kind: "claude",
      baseUrl: "",
      apiKey: "",
      login: { create: loginData(session(account)) },
    },
  });
}

function deleteAudit(linkId: string) {
  return prisma.gatewayAuditLog.findFirst({ where: { objectId: linkId, action: "provider_sub_add.delete" } });
}

test("concurrent contributors cannot add more accounts than the link allows, and the last slot deletes the link", async () => {
  const link = await createLink({ maxAccounts: 2 });
  const providerIds: string[] = [];
  try {
    const attempts = await Promise.allSettled(
      [1, 2, 3, 4].map((index) =>
        storeSubAddAccount({
          linkId: link.id,
          kind: "claude",
          session: session(`${uniqueName(`race-${index}`)}@example.test`),
          manageHash: newSubAddToken().hash,
          loginVerified: false,
        }),
      ),
    );
    stopLocalCatalogTasks();
    for (const attempt of attempts) if (attempt.status === "fulfilled") providerIds.push(attempt.value.providerId);
    const refused = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    assert.equal(providerIds.length, 2);
    for (const attempt of refused) assert.equal((attempt.reason as Error).message, "SUB_ADD_UNAVAILABLE");
    assert.equal(await prisma.subAddLink.count({ where: { id: link.id } }), 0);
    const kept = await prisma.subAddAccount.findMany({ where: { providerId: { in: providerIds } } });
    assert.deepEqual(
      kept.map((row) => [row.linkId, row.label]),
      [
        [null, link.label],
        [null, link.label],
      ],
    );
    const audit = await deleteAudit(link.id);
    assert.equal(audit?.actor, `sub-add:${link.id}`);
    assert.deepEqual(JSON.parse(audit?.afterJson ?? "{}"), { reason: "used_up" });
  } finally {
    await cleanup([link.id], providerIds);
  }
});

test("accounts added through a restricted link get its assignments, and re-adding one does not use a slot", async () => {
  const org = await prisma.organization.create({ data: { alias: uniqueName("org") } });
  const link = await createLink({ maxAccounts: 2, restricted: true, orgId: org.id });
  const account = `${uniqueName("friend")}@example.test`;
  const providerIds: string[] = [];
  try {
    const owner = newSubAddToken();
    const first = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(account),
      manageHash: owner.hash,
      loginVerified: false,
    });
    providerIds.push(first.providerId);
    assert.equal(first.outcome, "created");
    const provider = await prisma.providerConnection.findUniqueOrThrow({
      where: { id: first.providerId },
      include: { assignments: true, login: true, subAdd: true },
    });
    assert.equal(provider.restricted, true);
    assert.deepEqual(provider.assignments.map((row) => row.orgId), [org.id]);
    assert.equal(provider.subAdd?.linkId, link.id);
    assert.equal(provider.subAdd?.label, link.label);
    assert.doesNotMatch(provider.login?.tokens ?? "", /access-|refresh-/);

    const renewed = newSubAddToken();
    await assert.rejects(
      storeSubAddAccount({
        linkId: link.id,
        kind: "claude",
        session: session(account.toUpperCase(), account),
        manageHash: renewed.hash,
        loginVerified: false,
      }),
      { message: "SUB_ADD_LOGIN_UNVERIFIED" },
    );
    assert.equal((await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: first.providerId } })).version, 0);
    const second = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(account.toUpperCase(), account),
      manageHash: renewed.hash,
      loginVerified: true,
    });
    assert.deepEqual(second, { providerId: first.providerId, outcome: "updated" });
    assert.equal((await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } })).added, 1);
    const moved = await prisma.subAddAccount.findUniqueOrThrow({ where: { providerId: first.providerId } });
    assert.equal(moved.manageHash, renewed.hash);
    assert.equal(moved.linkId, link.id);

    const last = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(`${uniqueName("last")}@example.test`),
      manageHash: renewed.hash,
      loginVerified: false,
    });
    providerIds.push(last.providerId);
    assert.equal(await prisma.subAddLink.count({ where: { id: link.id } }), 0);
    assert.equal(await prisma.subAddTarget.count({ where: { linkId: link.id } }), 0);
    assert.equal(await prisma.providerAssignment.count({ where: { providerId: { in: providerIds }, orgId: org.id } }), 2);

    await assert.rejects(
      storeSubAddAccount({
        linkId: link.id,
        kind: "claude",
        session: session(`${uniqueName("other")}@example.test`),
        manageHash: renewed.hash,
        loginVerified: false,
      }),
      { message: "SUB_ADD_UNAVAILABLE" },
    );
    stopLocalCatalogTasks();
  } finally {
    await cleanup([link.id], providerIds);
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test("a contributor disconnects an account and the hub deletes it with an audit row", async () => {
  const link = await createLink({ maxAccounts: null });
  const manage = newSubAddToken();
  try {
    const stored = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(`${uniqueName("leaver")}@example.test`),
      manageHash: manage.hash,
      loginVerified: false,
    });
    await assert.rejects(removeSubAddAccount(stored.providerId, newSubAddToken().hash), { message: "NOT_FOUND" });
    assert.equal(await prisma.providerConnection.count({ where: { id: stored.providerId } }), 1);

    await removeSubAddAccount(stored.providerId, manage.hash);
    stopLocalCatalogTasks();
    assert.equal(await prisma.providerConnection.count({ where: { id: stored.providerId } }), 0);
    assert.equal(await prisma.providerLogin.count({ where: { providerId: stored.providerId } }), 0);
    assert.equal(await prisma.subAddAccount.count({ where: { providerId: stored.providerId } }), 0);
    const audit = await prisma.gatewayAuditLog.findFirst({
      where: { objectId: stored.providerId, action: "provider.sub_add_removed" },
    });
    assert.equal(audit?.actor, `sub-add:${link.id}`);
    assert.equal((await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } })).added, 0);
  } finally {
    await cleanup([link.id]);
  }
});

test("disconnecting an account from the console frees its place so the link can add another one", async () => {
  const owner = await ownerSession();
  const link = await createLink({ maxAccounts: 2 });
  const providerIds: string[] = [];
  const add = async (name: string) => {
    const stored = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(`${uniqueName(name)}@example.test`),
      manageHash: newSubAddToken().hash,
      loginVerified: false,
    });
    providerIds.push(stored.providerId);
    return stored.providerId;
  };
  try {
    const removed = await add("leaves");
    assert.equal((await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } })).added, 1);
    await runAsPrincipal(owner, () => deleteProvider(removed));
    stopLocalCatalogTasks();
    assert.equal((await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } })).added, 0);
    await add("again");
    assert.equal(await prisma.subAddLink.count({ where: { id: link.id } }), 1);
    await add("full");
    stopLocalCatalogTasks();
    assert.equal(await prisma.subAddLink.count({ where: { id: link.id } }), 0);
  } finally {
    await cleanup([link.id], providerIds);
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});

test("revoking a link deletes it and its targets while its accounts stay connected and removable", async () => {
  const owner = await ownerSession();
  const org = await prisma.organization.create({ data: { alias: uniqueName("org") } });
  const link = await createLink({ maxAccounts: null, restricted: true, orgId: org.id });
  const manage = newSubAddToken();
  const providerIds: string[] = [];
  try {
    const stored = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(`${uniqueName("stays")}@example.test`),
      manageHash: manage.hash,
      loginVerified: false,
    });
    providerIds.push(stored.providerId);
    stopLocalCatalogTasks();
    assert.deepEqual(await runAsPrincipal(owner, () => deleteSubAddLink(link.id)), { id: link.id });
    await assert.rejects(runAsPrincipal(owner, () => deleteSubAddLink(link.id)), { message: "NOT_FOUND" });

    assert.equal(await prisma.subAddLink.count({ where: { id: link.id } }), 0);
    assert.equal(await prisma.subAddTarget.count({ where: { linkId: link.id } }), 0);
    const account = await prisma.subAddAccount.findUniqueOrThrow({ where: { providerId: stored.providerId } });
    assert.equal(account.linkId, null);
    assert.equal(account.label, link.label);
    assert.equal(await prisma.providerAssignment.count({ where: { providerId: stored.providerId, orgId: org.id } }), 1);
    const { connected } = await runAsPrincipal(owner, () => loadProviders());
    assert.equal(connected.find((row) => row.id === stored.providerId)?.sharedVia, link.label);
    const audit = await deleteAudit(link.id);
    assert.equal(audit?.actor, owner.user.id);
    assert.deepEqual(JSON.parse(audit?.afterJson ?? "{}"), { reason: "revoked" });
    assert.equal(JSON.parse(audit?.beforeJson ?? "{}").label, link.label);

    await removeSubAddAccount(stored.providerId, manage.hash);
    stopLocalCatalogTasks();
    assert.equal(await prisma.providerConnection.count({ where: { id: stored.providerId } }), 0);
    const removed = await prisma.gatewayAuditLog.findFirst({
      where: { objectId: stored.providerId, action: "provider.sub_add_removed" },
    });
    assert.equal(removed?.actor, "sub-add");
  } finally {
    await cleanup([link.id], providerIds);
    await prisma.organization.deleteMany({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});

test("the sweep deletes expired and used-up links with an audit row and the console lists only usable ones", async () => {
  const owner = await ownerSession();
  const expired = await createLink({ maxAccounts: null, expiresAt: new Date(Date.now() - 1000) });
  const usedUp = await createLink({ maxAccounts: 1, added: 1 });
  const unlimited = await createLink({ maxAccounts: null, added: 7 });
  const room = await createLink({ maxAccounts: 2, added: 1 });
  const ids = [expired.id, usedUp.id, unlimited.id, room.id];
  try {
    const listed = await runAsPrincipal(owner, () => loadSubAddLinks());
    assert.deepEqual(
      listed.links.map((row) => row.id).filter((id) => ids.includes(id)).sort(),
      [unlimited.id, room.id].sort(),
    );

    const removed = await pruneSubAddLinks("worker");
    assert.ok(removed.includes(expired.id));
    assert.ok(removed.includes(usedUp.id));
    assert.equal(removed.includes(unlimited.id) || removed.includes(room.id), false);
    assert.equal(await prisma.subAddLink.count({ where: { id: { in: ids } } }), 2);
    for (const [id, reason] of [
      [expired.id, "expired"],
      [usedUp.id, "used_up"],
    ]) {
      const audit = await deleteAudit(id);
      assert.equal(audit?.actor, "worker");
      assert.deepEqual(JSON.parse(audit?.afterJson ?? "{}"), { reason });
    }
    assert.deepEqual(
      (await pruneSubAddLinks("worker")).filter((id) => ids.includes(id)),
      [],
    );
  } finally {
    await cleanup(ids);
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});

test("an unverified link sign-in leaves a console-added connection and its management untouched", async () => {
  const account = `${uniqueName("console")}@example.test`;
  const existing = await consoleConnection(account);
  const link = await createLink({ maxAccounts: 1 });
  const manage = newSubAddToken();
  try {
    await assert.rejects(
      storeSubAddAccount({
        linkId: link.id,
        kind: "claude",
        session: session(account),
        manageHash: manage.hash,
        loginVerified: false,
      }),
      { message: "SUB_ADD_LOGIN_UNVERIFIED" },
    );
    assert.equal((await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: existing.id } })).version, 0);
    assert.equal(await prisma.subAddAccount.count({ where: { providerId: existing.id } }), 0);
    await assert.rejects(removeSubAddAccount(existing.id, manage.hash), { message: "NOT_FOUND" });
    assert.equal(await prisma.providerConnection.count({ where: { id: existing.id } }), 1);
  } finally {
    await cleanup([link.id], [existing.id]);
  }
});

test("a verified link sign-in renews a console-added connection and lets the contributor manage it without using a place", async () => {
  const account = `${uniqueName("console")}@example.test`;
  const existing = await consoleConnection(account);
  const link = await createLink({ maxAccounts: 1 });
  const manage = newSubAddToken();
  try {
    const stored = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(account),
      manageHash: manage.hash,
      loginVerified: true,
    });
    stopLocalCatalogTasks();
    assert.deepEqual(stored, { providerId: existing.id, outcome: "updated" });
    assert.equal((await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: existing.id } })).version, 1);
    const managed = await prisma.subAddAccount.findUniqueOrThrow({ where: { providerId: existing.id } });
    assert.equal(managed.manageHash, manage.hash);
    assert.equal(managed.linkId, null);
    assert.equal(managed.label, link.label);
    assert.equal((await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } })).added, 0);
    await removeSubAddAccount(existing.id, manage.hash);
    stopLocalCatalogTasks();
    assert.equal(await prisma.providerConnection.count({ where: { id: existing.id } }), 0);
    assert.equal((await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } })).added, 0);
  } finally {
    await cleanup([link.id], [existing.id]);
  }
});

test("a second contributor takes over management only with a verified sign-in to the same account", async () => {
  const account = `${uniqueName("shared")}@example.test`;
  const link = await createLink({ maxAccounts: null });
  const first = newSubAddToken();
  const second = newSubAddToken();
  const providerIds: string[] = [];
  const signIn = (manageHash: string, loginVerified: boolean) =>
    storeSubAddAccount({ linkId: link.id, kind: "claude", session: session(account), manageHash, loginVerified });
  try {
    const added = await signIn(first.hash, false);
    providerIds.push(added.providerId);
    await assert.rejects(signIn(second.hash, false), { message: "SUB_ADD_LOGIN_UNVERIFIED" });
    const kept = await prisma.subAddAccount.findUniqueOrThrow({ where: { providerId: added.providerId } });
    assert.equal(kept.manageHash, first.hash);
    await assert.rejects(removeSubAddAccount(added.providerId, second.hash), { message: "NOT_FOUND" });

    const renewed = await signIn(second.hash, true);
    stopLocalCatalogTasks();
    assert.deepEqual(renewed, { providerId: added.providerId, outcome: "updated" });
    const moved = await prisma.subAddAccount.findUniqueOrThrow({ where: { providerId: added.providerId } });
    assert.equal(moved.manageHash, second.hash);
    assert.equal(moved.linkId, link.id);
    assert.equal((await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } })).added, 1);
    await assert.rejects(removeSubAddAccount(added.providerId, first.hash), { message: "NOT_FOUND" });
    await removeSubAddAccount(added.providerId, second.hash);
    stopLocalCatalogTasks();
    assert.equal(await prisma.providerConnection.count({ where: { id: added.providerId } }), 0);
    assert.equal((await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } })).added, 0);
  } finally {
    await cleanup([link.id], providerIds);
  }
});

test("a used-up link renews no connection", async () => {
  const account = `${uniqueName("full")}@example.test`;
  const existing = await consoleConnection(account);
  const link = await createLink({ maxAccounts: 1, added: 1 });
  try {
    await assert.rejects(
      storeSubAddAccount({
        linkId: link.id,
        kind: "claude",
        session: session(account),
        manageHash: newSubAddToken().hash,
        loginVerified: true,
      }),
      { message: "SUB_ADD_UNAVAILABLE" },
    );
    assert.equal((await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: existing.id } })).version, 0);
  } finally {
    await cleanup([link.id], [existing.id]);
  }
});
