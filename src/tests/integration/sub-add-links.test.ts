import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { newSubAddToken, removeSubAddAccount, storeSubAddAccount } from "@/lib/providers/sub-add-store";
import type { SignInSession } from "@/types/providers";
import { closeDatabase, uniqueName } from "./support/database";

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

async function createLink(data: { maxAccounts: number | null; restricted?: boolean; orgId?: string }) {
  return prisma.subAddLink.create({
    data: {
      label: uniqueName("link"),
      tokenHash: newSubAddToken().hash,
      kinds: ["claude"],
      maxAccounts: data.maxAccounts,
      restricted: data.restricted ?? false,
      expiresAt: new Date(Date.now() + DAY_MS),
      ...(data.orgId ? { targets: { create: [{ orgId: data.orgId }] } } : {}),
    },
  });
}

async function cleanup(linkId: string) {
  const accounts = await prisma.subAddAccount.findMany({ where: { linkId }, select: { providerId: true } });
  await prisma.providerConnection.deleteMany({ where: { id: { in: accounts.map((row) => row.providerId) } } });
  await prisma.subAddLink.deleteMany({ where: { id: linkId } });
}

test("concurrent contributors cannot add more accounts than the link allows", async () => {
  const link = await createLink({ maxAccounts: 2 });
  try {
    const attempts = await Promise.allSettled(
      [1, 2, 3, 4].map((index) =>
        storeSubAddAccount({
          linkId: link.id,
          kind: "claude",
          session: session(`${uniqueName(`race-${index}`)}@example.test`),
          manageHash: newSubAddToken().hash,
        }),
      ),
    );
    stopLocalCatalogTasks();
    const added = attempts.filter((attempt) => attempt.status === "fulfilled");
    const refused = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    assert.equal(added.length, 2);
    for (const attempt of refused) assert.equal((attempt.reason as Error).message, "SUB_ADD_UNAVAILABLE");
    const row = await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } });
    assert.equal(row.added, 2);
    assert.equal(await prisma.subAddAccount.count({ where: { linkId: link.id } }), 2);
  } finally {
    await cleanup(link.id);
  }
});

test("accounts added through a restricted link get its assignments, and re-adding one does not use a slot", async () => {
  const org = await prisma.organization.create({ data: { alias: uniqueName("org") } });
  const link = await createLink({ maxAccounts: 1, restricted: true, orgId: org.id });
  const account = `${uniqueName("friend")}@example.test`;
  try {
    const first = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(account),
      manageHash: newSubAddToken().hash,
    });
    assert.equal(first.outcome, "created");
    const provider = await prisma.providerConnection.findUniqueOrThrow({
      where: { id: first.providerId },
      include: { assignments: true, login: true, subAdd: true },
    });
    assert.equal(provider.restricted, true);
    assert.deepEqual(provider.assignments.map((row) => row.orgId), [org.id]);
    assert.equal(provider.subAdd?.linkId, link.id);
    assert.doesNotMatch(provider.login?.tokens ?? "", /access-|refresh-/);

    const renewed = newSubAddToken();
    const second = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(account.toUpperCase(), account),
      manageHash: renewed.hash,
    });
    assert.deepEqual(second, { providerId: first.providerId, outcome: "updated" });
    assert.equal((await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } })).added, 1);
    assert.equal(
      (await prisma.subAddAccount.findUniqueOrThrow({ where: { providerId: first.providerId } })).manageHash,
      renewed.hash,
    );

    await assert.rejects(
      storeSubAddAccount({
        linkId: link.id,
        kind: "claude",
        session: session(`${uniqueName("other")}@example.test`),
        manageHash: renewed.hash,
      }),
      { message: "SUB_ADD_UNAVAILABLE" },
    );
    stopLocalCatalogTasks();
  } finally {
    await cleanup(link.id);
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
    assert.equal((await prisma.subAddLink.findUniqueOrThrow({ where: { id: link.id } })).added, 1);
  } finally {
    await cleanup(link.id);
  }
});
