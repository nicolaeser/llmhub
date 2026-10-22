import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { acquireGroup, loadGroup } from "@/lib/gateway/routing/runtime";
import { loginData } from "@/lib/gateway/upstreams/credentials";
import { sealTicket } from "@/lib/gateway/upstreams/subscription-sign-in";
import { SUB_ADD_TOKEN_PATTERN } from "@/lib/http/public-path";
import { deleteProvider, loadProviders } from "@/lib/providers/connections";
import {
  completeSubAddSignIn,
  loadSubAddContributions,
  removeSubAddContribution,
  renewSubAddManage,
  revokeSubAddManage,
} from "@/lib/providers/sub-add";
import { deleteSubAddLink, loadSubAddLinks } from "@/lib/providers/sub-add-links";
import { pruneSubAddLinks } from "@/lib/providers/sub-add-prune";
import {
  newSubAddToken,
  removeSubAddAccount,
  storeSubAddAccount,
  subAddTokenHash,
  subAddUid,
} from "@/lib/providers/sub-add-store";
import type { SignInSession } from "@/types/providers";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";
import { setRequestHeaders } from "./support/next-request.mjs";

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
  data: {
    maxAccounts: number | null;
    added?: number;
    restricted?: boolean;
    orgId?: string;
    expiresAt?: Date;
    tokenHash?: string;
  },
) {
  return prisma.subAddLink.create({
    data: {
      label: uniqueName("link"),
      tokenHash: data.tokenHash ?? newSubAddToken().hash,
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
    assert.deepEqual(second, { providerId: first.providerId, outcome: "updated", manageHash: renewed.hash });
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
    assert.deepEqual(stored, { providerId: existing.id, outcome: "updated", manageHash: manage.hash });
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
    assert.deepEqual(renewed, { providerId: added.providerId, outcome: "updated", manageHash: second.hash });
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

let client = 0;

function freshClient() {
  client += 1;
  setRequestHeaders({ "x-forwarded-for": `203.0.113.${client}` });
}

async function contribute(linkId: string, manageHash: string, name: string) {
  const stored = await storeSubAddAccount({
    linkId,
    kind: "claude",
    session: session(`${uniqueName(name)}@example.test`),
    manageHash,
    loginVerified: false,
  });
  stopLocalCatalogTasks();
  return stored.providerId;
}

async function managedHashes(providerIds: string[]) {
  const rows = await prisma.subAddAccount.findMany({
    where: { providerId: { in: providerIds } },
    select: { providerId: true, manageHash: true },
  });
  return new Map(rows.map((row) => [row.providerId, row.manageHash]));
}

async function manageAudits(action: string, providerIds: string[]) {
  return prisma.gatewayAuditLog.findMany({ where: { action, objectId: { in: providerIds } }, orderBy: { objectId: "asc" } });
}

test("deactivating a manage link keeps its accounts connected and routed while the link stops working", async () => {
  freshClient();
  const owner = await ownerSession();
  const link = await createLink({ maxAccounts: null });
  const manage = newSubAddToken();
  const other = newSubAddToken();
  const alias = uniqueName("claude-route");
  const providerIds: string[] = [];
  try {
    providerIds.push(await contribute(link.id, manage.hash, "first"));
    providerIds.push(await contribute(link.id, manage.hash, "second"));
    const otherId = await contribute(link.id, other.hash, "other");
    providerIds.push(otherId);
    const [first, second] = providerIds;
    await prisma.modelGroup.create({
      data: { alias, deployments: { create: [{ kind: "claude", providerId: first, model: "claude-test" }] } },
    });

    assert.deepEqual(
      (await loadSubAddContributions({ manage: manage.token })).accounts.map((row) => row.providerId).sort(),
      [first, second].sort(),
    );
    const revoked = await revokeSubAddManage({ manage: manage.token });
    assert.equal(revoked.accounts, 2);

    const hashes = await managedHashes(providerIds);
    assert.equal(hashes.get(first), null);
    assert.equal(hashes.get(second), null);
    assert.equal(hashes.get(otherId), other.hash);
    assert.equal(await prisma.providerConnection.count({ where: { id: { in: providerIds } } }), 3);
    assert.equal(await prisma.providerLogin.count({ where: { providerId: { in: providerIds }, status: "active" } }), 3);
    const acquired = await acquireGroup(await loadGroup(alias), undefined);
    acquired.release();
    assert.equal(acquired.dep.provider_id, first);

    await assert.rejects(loadSubAddContributions({ manage: manage.token }), { message: "SUB_ADD_UNAVAILABLE" });
    await assert.rejects(revokeSubAddManage({ manage: manage.token }), { message: "SUB_ADD_UNAVAILABLE" });
    await assert.rejects(renewSubAddManage({ manage: manage.token }), { message: "SUB_ADD_UNAVAILABLE" });
    await assert.rejects(removeSubAddContribution({ manage: manage.token, providerId: first }), { message: "NOT_FOUND" });
    await assert.rejects(loadSubAddContributions({ manage: newSubAddToken().token }), { message: "SUB_ADD_UNAVAILABLE" });
    assert.deepEqual(
      (await loadSubAddContributions({ manage: other.token })).accounts.map((row) => row.providerId),
      [otherId],
    );
    await removeSubAddAccount(otherId, other.hash);
    stopLocalCatalogTasks();
    assert.equal(await prisma.providerConnection.count({ where: { id: { in: [first, second] } } }), 2);

    const { connected } = await runAsPrincipal(owner, () => loadProviders());
    for (const id of [first, second]) {
      const row = connected.find((provider) => provider.id === id);
      assert.equal(row?.sharedVia, link.label);
      assert.equal(row?.manageActive, false);
    }
    const listed = (await runAsPrincipal(owner, () => loadSubAddLinks())).links.find((row) => row.id === link.id);
    assert.deepEqual(
      listed?.accounts.map((account) => account.manageActive),
      [false, false],
    );

    const audits = await manageAudits("provider_sub_add.manage_revoke", providerIds);
    assert.deepEqual(
      audits.map((row) => [row.objectId, row.actor, row.objectType]),
      [first, second].sort().map((id) => [id, subAddUid(link.id), "provider"]),
    );
    for (const row of audits) {
      for (const value of [manage.token, manage.hash]) {
        assert.doesNotMatch(row.afterJson + row.beforeJson, new RegExp(value));
      }
    }
  } finally {
    await prisma.modelGroup.deleteMany({ where: { alias } });
    await cleanup([link.id], providerIds);
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});

test("renewing a manage link moves its accounts to the new link and the old one stops working at once", async () => {
  freshClient();
  const link = await createLink({ maxAccounts: null });
  const manage = newSubAddToken();
  const providerIds: string[] = [];
  try {
    providerIds.push(await contribute(link.id, manage.hash, "first"));
    providerIds.push(await contribute(link.id, manage.hash, "second"));
    const [first, second] = providerIds;

    const renewed = await renewSubAddManage({ manage: manage.token });
    assert.match(renewed.manageToken, SUB_ADD_TOKEN_PATTERN);
    assert.notEqual(renewed.manageToken, manage.token);
    assert.deepEqual(renewed.accounts.map((row) => row.providerId).sort(), [first, second].sort());
    const nextHash = subAddTokenHash(renewed.manageToken);
    const hashes = await managedHashes(providerIds);
    assert.deepEqual([hashes.get(first), hashes.get(second)], [nextHash, nextHash]);

    await assert.rejects(loadSubAddContributions({ manage: manage.token }), { message: "SUB_ADD_UNAVAILABLE" });
    await assert.rejects(renewSubAddManage({ manage: manage.token }), { message: "SUB_ADD_UNAVAILABLE" });
    await assert.rejects(revokeSubAddManage({ manage: manage.token }), { message: "SUB_ADD_UNAVAILABLE" });
    await assert.rejects(removeSubAddContribution({ manage: manage.token, providerId: first }), { message: "NOT_FOUND" });
    assert.equal(await prisma.providerConnection.count({ where: { id: { in: providerIds } } }), 2);

    const listed = await loadSubAddContributions({ manage: renewed.manageToken });
    assert.deepEqual(listed.accounts.map((row) => row.providerId).sort(), [first, second].sort());
    const audits = await manageAudits("provider_sub_add.manage_renew", providerIds);
    assert.equal(audits.length, 2);
    for (const row of audits) {
      for (const value of [manage.token, manage.hash, renewed.manageToken, nextHash]) {
        assert.doesNotMatch(row.afterJson + row.beforeJson, new RegExp(value));
      }
    }

    const left = await removeSubAddContribution({ manage: renewed.manageToken, providerId: first });
    stopLocalCatalogTasks();
    assert.deepEqual(left.accounts.map((row) => row.providerId), [second]);
    assert.equal(await prisma.providerConnection.count({ where: { id: first } }), 0);
  } finally {
    await cleanup([link.id], providerIds);
  }
});

test("a sign-in that brings a deactivated manage link gets a fresh one instead", async () => {
  freshClient();
  const linkToken = newSubAddToken();
  const link = await createLink({ maxAccounts: null, tokenHash: linkToken.hash });
  const manage = newSubAddToken();
  const providerIds: string[] = [];
  const realFetch = globalThis.fetch;
  const email = `${uniqueName("again")}@example.test`;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "platform.claude.com" && url.pathname === "/v1/oauth/token") {
      return Response.json({
        access_token: "sk-ant-oat-access-secret",
        refresh_token: "sk-ant-ort-refresh-secret",
        expires_in: 3600,
        account: { uuid: uniqueName("uuid"), email_address: email },
      });
    }
    return Response.json({});
  }) as typeof fetch;
  try {
    const earlier = await contribute(link.id, manage.hash, "earlier");
    providerIds.push(earlier);
    await revokeSubAddManage({ manage: manage.token });

    const done = await completeSubAddSignIn({
      token: linkToken.token,
      ticket: sealTicket(subAddUid(link.id), {
        grant: { kind: "claude", verifier: "verifier-1", state: "state-1" },
        verificationUrl: "https://claude.ai/oauth/authorize",
        userCode: "",
        interval: 5,
        expiresIn: 600,
      }),
      code: "code-1#state-1",
      manage: manage.token,
    });
    stopLocalCatalogTasks();
    assert.equal(done.state, "done");
    if (done.state !== "done") return;
    assert.equal(done.outcome, "created");
    assert.match(done.manageToken, SUB_ADD_TOKEN_PATTERN);
    assert.notEqual(done.manageToken, manage.token);
    const added = await prisma.providerLogin.findFirstOrThrow({ where: { account: email }, select: { providerId: true } });
    providerIds.push(added.providerId);
    const hashes = await managedHashes(providerIds);
    assert.equal(hashes.get(earlier), null);
    assert.equal(hashes.get(added.providerId), subAddTokenHash(done.manageToken));
    assert.deepEqual(
      (await loadSubAddContributions({ manage: done.manageToken })).accounts.map((row) => row.providerId),
      [added.providerId],
    );
    await assert.rejects(loadSubAddContributions({ manage: manage.token }), { message: "SUB_ADD_UNAVAILABLE" });
  } finally {
    globalThis.fetch = realFetch;
    await cleanup([link.id], providerIds);
  }
});

test("a sign-in racing a deactivation or renewal never brings the old manage link back", async () => {
  freshClient();
  const link = await createLink({ maxAccounts: null });
  const providerIds: string[] = [];
  const signIn = (name: string, manageHash: string, broughtManageHash: string) =>
    storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(`${uniqueName(name)}@example.test`),
      manageHash,
      broughtManageHash,
      loginVerified: false,
    });
  try {
    const kept = newSubAddToken();
    providerIds.push(await contribute(link.id, kept.hash, "kept"));
    const joined = await signIn("joined", newSubAddToken().hash, kept.hash);
    providerIds.push(joined.providerId);
    assert.equal(joined.manageHash, kept.hash);

    for (const change of ["revoke", "renew"] as const) {
      for (let round = 0; round < 3; round += 1) {
        const manage = newSubAddToken();
        const fresh = newSubAddToken();
        providerIds.push(await contribute(link.id, manage.hash, `${change}-earlier`));
        const [stored, changed] = await Promise.all([
          signIn(`${change}-racing`, fresh.hash, manage.hash),
          change === "revoke" ? revokeSubAddManage({ manage: manage.token }) : renewSubAddManage({ manage: manage.token }),
        ]);
        providerIds.push(stored.providerId);
        assert.equal(await prisma.subAddAccount.count({ where: { manageHash: manage.hash } }), 0);
        const hash = (await managedHashes([stored.providerId])).get(stored.providerId);
        if (stored.manageHash === fresh.hash) {
          assert.equal(hash, fresh.hash);
        } else {
          assert.equal(stored.manageHash, manage.hash);
          assert.equal(hash, "manageToken" in changed ? subAddTokenHash(changed.manageToken) : null);
        }
      }
    }
    stopLocalCatalogTasks();
  } finally {
    await cleanup([link.id], providerIds);
  }
});
