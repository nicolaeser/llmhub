import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { createFirstAdmin } from "@/lib/bootstrap/first-admin";
import { closeDatabase, createUser, uniqueName } from "./support/database";
import { documentationAddress } from "./support/factors";
import { setRequestHeaders } from "./support/next-request.mjs";

after(closeDatabase);

function ownerInput() {
  const username = uniqueName("owner");
  return { username, email: `${username}@example.test`, password: `Setup-${randomBytes(12).toString("hex")}-9z` };
}

test("setup refuses to create a second owner once any user exists", async () => {
  const existing = await createUser();
  const ip = documentationAddress();
  const input = ownerInput();
  setRequestHeaders({ "x-forwarded-for": `198.51.100.7, ${ip}` });
  try {
    const result = await createFirstAdmin(input);

    assert.deepEqual(result, { ok: false, error: "SETUP_ALREADY_COMPLETE" });
    assert.equal(
      await prisma.user.count({ where: { OR: [{ email: input.email }, { username: input.username }] } }),
      0,
    );
    assert.equal(
      await prisma.gatewayAuditLog.count({
        where: { action: "setup.owner_created", afterJson: { contains: input.email } },
      }),
      0,
    );
  } finally {
    await prisma.loginAttempt.deleteMany({ where: { key: `setup:${ip}` } });
    await prisma.user.deleteMany({ where: { OR: [{ id: existing.id }, { email: input.email }] } });
  }
});

test("setup reports input problems with their policy codes and allows ten attempts per client", async () => {
  const ip = documentationAddress();
  setRequestHeaders({ "x-forwarded-for": ip });
  try {
    const input = ownerInput();
    assert.deepEqual(await createFirstAdmin({ ...input, password: "short1" }), { ok: false, error: "WEAK_PASSWORD" });
    assert.deepEqual(await createFirstAdmin({ ...input, password: `${input.username}-Aa1` }), {
      ok: false,
      error: "PASSWORD_GUESSABLE",
    });
    for (let attempt = 2; attempt < 10; attempt += 1) {
      assert.deepEqual(await createFirstAdmin({ ...input, email: "not-an-email" }), { ok: false, error: "VALIDATION" });
    }
    assert.deepEqual(await createFirstAdmin(input), { ok: false, error: "RATE_LIMITED" });
    assert.equal(await prisma.user.count({ where: { email: input.email } }), 0);
  } finally {
    await prisma.loginAttempt.deleteMany({ where: { key: `setup:${ip}` } });
  }
});

test("racing setup requests on an empty user table create exactly one owner and no session", async (t) => {
  if ((await prisma.user.count()) > 0) {
    t.skip("the user table is not empty");
    return;
  }
  const clients = [documentationAddress(), documentationAddress(), documentationAddress()];
  const inputs = clients.map(() => ownerInput());
  try {
    const results = await Promise.all(
      inputs.map((input, index) => {
        setRequestHeaders({ "x-forwarded-for": clients[index] });
        return createFirstAdmin(input);
      }),
    );

    assert.deepEqual(
      results.map((result) => (result.ok ? "ok" : result.error)).sort(),
      ["SETUP_ALREADY_COMPLETE", "SETUP_ALREADY_COMPLETE", "ok"],
    );
    const owners = await prisma.user.findMany({
      where: { email: { in: inputs.map((input) => input.email) } },
      include: { role: true },
    });
    assert.equal(owners.length, 1);
    const [owner] = owners;
    assert.equal(owner.isOwner, true);
    assert.equal(owner.role?.templateKey, "admin");
    assert.equal(await prisma.session.count({ where: { userId: owner.id } }), 0);
    assert.equal(await prisma.loginChallenge.count({ where: { userId: owner.id, purpose: "ENROLL" } }), 1);
    assert.equal(await prisma.gatewayAuditLog.count({ where: { action: "setup.owner_created", objectId: owner.id } }), 1);
  } finally {
    const created = await prisma.user.findMany({
      where: { email: { in: inputs.map((input) => input.email) } },
      select: { id: true },
    });
    await prisma.gatewayAuditLog.deleteMany({ where: { objectId: { in: created.map((user) => user.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: created.map((user) => user.id) } } });
    await prisma.loginAttempt.deleteMany({ where: { key: { in: clients.map((ip) => `setup:${ip}`) } } });
  }
});
