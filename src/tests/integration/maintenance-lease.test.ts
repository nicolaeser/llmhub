import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { acquireLock, releaseLock } from "@/lib/gateway/catalog/catalog-state";
import { acquireLease, claimLease, releaseLease, renewLease } from "@/lib/jobs/lease";
import { closeDatabase, uniqueName } from "./support/database";

after(closeDatabase);

const CONTENDERS = 8;
const CATALOG_LOCK_KEY = "model_catalog_lock";

const storedValue = async (key: string) => (await prisma.setting.findUnique({ where: { key } }))?.value ?? null;

const held = (tokens: (string | null)[]) => tokens.filter((token): token is string => token !== null);

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

test("concurrent claims of a free lease leave exactly one holder whose token is stored", async () => {
  const key = uniqueName("lease");
  const now = Date.now();
  try {
    const tokens = await Promise.all(
      Array.from({ length: CONTENDERS }, (_, index) => acquireLease(key, 55_000, now + index)),
    );
    const winners = held(tokens);
    assert.equal(winners.length, 1);
    assert.equal(await storedValue(key), winners[0]);
  } finally {
    await prisma.setting.deleteMany({ where: { key } });
  }
});

test("concurrent takeovers of an expired lease leave exactly one holder whose token is stored", async () => {
  const key = uniqueName("lease");
  const now = Date.now();
  try {
    await prisma.setting.create({ data: { key, value: String(now - 1) } });
    const tokens = await Promise.all(
      Array.from({ length: CONTENDERS }, (_, index) => acquireLease(key, 55_000, now + index)),
    );
    const winners = held(tokens);
    assert.equal(winners.length, 1);
    assert.equal(await storedValue(key), winners[0]);
  } finally {
    await prisma.setting.deleteMany({ where: { key } });
  }
});

test("only the holder's token renews or releases a lease", async () => {
  const key = uniqueName("lease");
  const now = Date.now();
  try {
    const token = await acquireLease(key, 55_000, now);
    assert.equal(token, String(now + 55_000));

    assert.equal(await renewLease(key, "stale", 55_000, now + 1_000), null);
    await releaseLease(key, "stale");
    assert.equal(await storedValue(key), token);
    assert.equal(await acquireLease(key, 55_000, now + 1_000), null);

    const renewed = await renewLease(key, token, 55_000, now + 1_000);
    assert.equal(renewed, String(now + 56_000));
    await releaseLease(key, token);
    assert.equal(await storedValue(key), renewed);

    await releaseLease(key, renewed);
    assert.equal(await storedValue(key), null);
    assert.equal(await acquireLease(key, 55_000, now + 2_000), String(now + 57_000));
  } finally {
    await prisma.setting.deleteMany({ where: { key } });
  }
});

test("the model catalog lock admits one refresh at a time and is taken over once expired", async () => {
  const leftover = await prisma.setting.findUnique({ where: { key: CATALOG_LOCK_KEY } });
  if (leftover) await prisma.setting.deleteMany({ where: leftover });
  const expired = String(Date.now() - 1);
  const taken: string[] = [expired];
  try {
    const winners = held(await Promise.all(Array.from({ length: CONTENDERS }, () => acquireLock())));
    taken.push(...winners);
    assert.equal(winners.length, 1);
    assert.equal(await storedValue(CATALOG_LOCK_KEY), winners[0]);
    assert.equal(await acquireLock(), null);
    await releaseLock("stale");
    assert.equal(await storedValue(CATALOG_LOCK_KEY), winners[0]);
    await releaseLock(winners[0]);
    assert.equal(await storedValue(CATALOG_LOCK_KEY), null);

    await prisma.setting.create({ data: { key: CATALOG_LOCK_KEY, value: expired } });
    const takeover = await acquireLock();
    assert.ok(takeover);
    taken.push(takeover);
    assert.equal(await storedValue(CATALOG_LOCK_KEY), takeover);
    await releaseLock(takeover);
    assert.equal(await storedValue(CATALOG_LOCK_KEY), null);
  } finally {
    await prisma.setting.deleteMany({ where: { key: CATALOG_LOCK_KEY, value: { in: taken } } });
    if (leftover) await prisma.setting.createMany({ data: [leftover], skipDuplicates: true });
  }
});
