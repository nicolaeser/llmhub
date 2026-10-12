import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { createFirstAdmin } from "@/lib/bootstrap/first-admin";
import { closeDatabase, createUser, uniqueName } from "./support/database";
import { setRequestHeaders } from "./support/next-request.mjs";

after(closeDatabase);

function documentationAddress(): string {
  return `2001:db8::${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
}

test("setup refuses to create a second owner once any user exists", async () => {
  const existing = await createUser();
  const ip = documentationAddress();
  const username = uniqueName("owner");
  const email = `${username}@example.test`;
  setRequestHeaders({ "x-forwarded-for": `198.51.100.7, ${ip}` });
  try {
    const result = await createFirstAdmin({
      username,
      email,
      password: `Setup-${randomBytes(12).toString("hex")}-9z`,
    });

    assert.deepEqual(result, { ok: false, error: "SETUP_ALREADY_COMPLETE" });
    assert.equal(await prisma.user.count({ where: { OR: [{ email }, { username }] } }), 0);
    assert.equal(
      await prisma.gatewayAuditLog.count({ where: { action: "setup.owner_created", afterJson: { contains: email } } }),
      0,
    );
  } finally {
    await prisma.loginAttempt.deleteMany({ where: { key: `setup:${ip}` } });
    await prisma.user.delete({ where: { id: existing.id } });
  }
});
