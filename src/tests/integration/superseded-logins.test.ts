import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { loginData } from "@/lib/gateway/upstreams/credentials";
import { matchingConnection, pruneSupersededLogins } from "@/lib/providers/account-match";
import { newSubAddToken, storeSubAddAccount } from "@/lib/providers/sub-add-store";
import type { SignInSession } from "@/types/providers";
import { closeDatabase, uniqueName } from "./support/database";

after(closeDatabase);

const DAY_MS = 24 * 60 * 60 * 1000;

function session(account: string, accountId: string): SignInSession {
  return {
    tokens: { access: `access-${account}`, refresh: `refresh-${account}`, accountId, residency: "" },
    expiresAt: Date.now() + 3_600_000,
    account,
    plan: "max",
  };
}

async function connect(account: string, accountId: string, status: "active" | "expired") {
  return prisma.providerConnection.create({
    data: {
      name: uniqueName("claude"),
      kind: "claude",
      baseUrl: "",
      apiKey: "",
      login: { create: { ...loginData(session(account, accountId)), status } },
    },
  });
}

test("an expired account is removed once the same account is connected again", async () => {
  const account = `${uniqueName("twice")}@example.test`;
  const other = `${uniqueName("alone")}@example.test`;
  const stale = await connect(account, "id-twice", "expired");
  const lonely = await connect(other, "id-alone", "expired");
  const elsewhere = await connect(account, "id-elsewhere", "expired");
  const fresh = await connect(account.toUpperCase(), "id-twice", "active");
  try {
    const removed = await pruneSupersededLogins("worker");
    stopLocalCatalogTasks();
    assert.deepEqual(removed, [stale.id]);
    assert.equal(await prisma.providerConnection.count({ where: { id: stale.id } }), 0);
    assert.equal(await prisma.providerConnection.count({ where: { id: { in: [lonely.id, elsewhere.id, fresh.id] } } }), 3);
    const audit = await prisma.gatewayAuditLog.findFirst({ where: { objectId: stale.id, action: "provider.superseded" } });
    assert.equal(audit?.actor, "worker");
    assert.doesNotMatch(JSON.stringify(audit), /access-|refresh-/);
    assert.deepEqual(await pruneSupersededLogins("worker"), []);
  } finally {
    await prisma.providerConnection.deleteMany({ where: { id: { in: [stale.id, lonely.id, elsewhere.id, fresh.id] } } });
  }
});

test("a new sign-in renews the active connection of the account and removes its expired duplicate", async () => {
  const account = `${uniqueName("renew")}@example.test`;
  const stale = await connect(account, "id-renew", "expired");
  const fresh = await connect(account, "id-renew", "active");
  const link = await prisma.subAddLink.create({
    data: {
      label: uniqueName("link"),
      tokenHash: newSubAddToken().hash,
      kinds: ["claude"],
      maxAccounts: 1,
      expiresAt: new Date(Date.now() + DAY_MS),
    },
  });
  try {
    assert.equal(await matchingConnection("claude", session(account, "id-renew")), fresh.id);
    const stored = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(account, "id-renew"),
      manageHash: newSubAddToken().hash,
      loginVerified: true,
    });
    stopLocalCatalogTasks();
    assert.deepEqual(stored, { providerId: fresh.id, outcome: "updated" });
    assert.equal(await prisma.providerConnection.count({ where: { id: stale.id } }), 0);
    const login = await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: fresh.id } });
    assert.equal(login.status, "active");
    assert.equal(login.version, 1);
  } finally {
    await prisma.providerConnection.deleteMany({ where: { id: { in: [stale.id, fresh.id] } } });
    await prisma.subAddLink.deleteMany({ where: { id: link.id } });
  }
});

test("an expired account is renewed in place when no active duplicate exists", async () => {
  const account = `${uniqueName("revive")}@example.test`;
  const older = await connect(account, "id-revive", "expired");
  try {
    assert.equal(await matchingConnection("claude", session(account, "id-revive")), older.id);
    assert.equal(await matchingConnection("claude", session(account, "id-someone-else")), null);
    assert.equal(await matchingConnection("codex", session(account, "id-revive")), null);
  } finally {
    await prisma.providerConnection.deleteMany({ where: { id: older.id } });
  }
});
