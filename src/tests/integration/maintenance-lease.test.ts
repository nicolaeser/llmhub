import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { claimLease } from "@/lib/jobs/lease";
import { closeDatabase, uniqueName } from "./support/database";

after(closeDatabase);

test("only one replica holds a lease until it expires", async () => {
  const key = uniqueName("lease");
  const now = Date.now();
  try {
    const claims = await Promise.all([claimLease(key, 55_000, now), claimLease(key, 55_000, now)]);
    assert.deepEqual(claims.sort(), [false, true]);
    assert.equal(await claimLease(key, 55_000, now + 54_000), false);

    assert.equal(await claimLease(key, 55_000, now + 56_000), true);
    const row = await prisma.setting.findUniqueOrThrow({ where: { key } });
    assert.equal(row.value, String(now + 111_000));
  } finally {
    await prisma.setting.deleteMany({ where: { key } });
  }
});
