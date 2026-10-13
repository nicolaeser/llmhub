import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { Principal } from "@/types/gateway";

const DAY_MS = 86_400_000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });
let afterUserRead: ((id: string) => Promise<void>) | null = null;

function bound<T extends object>(target: T, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop);
  return typeof value === "function" ? value.bind(target) : value;
}

const users = new Proxy(db.user, {
  get(target, prop) {
    if (prop !== "findUnique") return bound(target, prop);
    return async (args: Parameters<typeof db.user.findUnique>[0]) => {
      const row = await target.findUnique(args);
      if (row && afterUserRead) await afterUserRead(row.id);
      return row;
    };
  },
});

Object.assign(globalThis, {
  pool,
  prisma: new Proxy(db, { get: (target, prop) => (prop === "user" ? users : bound(target, prop)) }),
});

after(async () => {
  const { closeDatabase } = await import("./support/database");
  await closeDatabase();
});

test("a period reset only lands while the row still holds the reset time it read", async () => {
  const { assertBudget } = await import("@/lib/gateway/billing/billing");
  const { createUser } = await import("./support/database");
  const user = await createUser();
  const principal: Principal = {
    actor: user.id,
    userId: user.id,
    memberId: "",
    teamId: "",
    orgId: "",
    models: [],
    routeLimits: {},
  };
  const elapsed = { maxBudget: 100, spend: 90, budgetDuration: "1d", spendResetAt: new Date(Date.now() - 2 * DAY_MS) };
  try {
    await db.user.update({ where: { id: user.id }, data: elapsed });
    const otherReset = new Date(Date.now() - 1_000);
    afterUserRead = async (id) => {
      if (id !== user.id) return;
      afterUserRead = null;
      await db.user.update({ where: { id }, data: { spend: 3, spendResetAt: otherReset } });
    };
    assert.deepEqual(await assertBudget(principal), { limit: 100, budget: "user" });
    const kept = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(kept.spend.toNumber(), 3);
    assert.equal(kept.spendResetAt?.getTime(), otherReset.getTime());

    await db.user.update({ where: { id: user.id }, data: elapsed });
    const started = Date.now();
    await Promise.all([assertBudget(principal), assertBudget(principal), assertBudget(principal)]);
    const reset = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(reset.spend.toNumber(), 0);
    assert.ok((reset.spendResetAt?.getTime() ?? 0) >= started);
  } finally {
    afterUserRead = null;
    await db.user.delete({ where: { id: user.id } });
  }
});
