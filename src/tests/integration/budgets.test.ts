import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { addBoost, removeBoost, saveBudgetAlerts, setBudget } from "@/lib/tenancy/budgets";
import type { Permission } from "@/types/auth";
import { closeDatabase, uniqueName } from "./support/database";
import { sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

const BUDGET_ADMIN: Permission[] = ["budgets:manage", "keys:read", "keys:read-all", "tenancy:read"];
const failsWith = (code: string) => (err: unknown) => err instanceof Error && err.message === code;

test("a budget cannot exceed the cap of any capped parent", async () => {
  const data = new TestData();
  try {
    const org = await data.org({ maxBudget: 100 });
    const team = await data.team(org.id);
    const project = await data.project(org.id, team.id, { maxBudget: 40 });
    const member = await data.member(org.id, team.id);
    const key = await data.key({ projectId: project.id, orgId: org.id, teamId: team.id });
    const admin = sessionOf(await data.user(), { permissions: BUDGET_ADMIN });
    const as = <T>(fn: () => Promise<T>) => runAsPrincipal(admin, fn);

    await assert.rejects(as(() => setBudget({ kind: "team", id: team.id, maxBudget: 150, budgetDuration: "" })), failsWith("BUDGET_EXCEEDS_PARENT"));
    await assert.rejects(as(() => setBudget({ kind: "member", id: member.id, maxBudget: 100.01, budgetDuration: "" })), failsWith("BUDGET_EXCEEDS_PARENT"));
    await assert.rejects(as(() => setBudget({ kind: "key", id: key.id, maxBudget: 41, budgetDuration: "30d" })), failsWith("BUDGET_EXCEEDS_PARENT"));
    assert.equal(Number((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).maxBudget), 0);

    const teamBudget = await as(() => setBudget({ kind: "team", id: team.id, maxBudget: 100, budgetDuration: "monthly" }));
    assert.equal(teamBudget.budget.maxBudget, 100);
    assert.equal(teamBudget.budget.budgetDuration, "30d");
    const keyBudget = await as(() => setBudget({ kind: "key", id: key.id, maxBudget: 40, budgetDuration: "" }));
    assert.equal(keyBudget.budget.maxBudget, 40);
    const unlimited = await as(() => setBudget({ kind: "member", id: member.id, maxBudget: 0, budgetDuration: "" }));
    assert.equal(unlimited.budget.maxBudget, 0);

    const uncappedOrg = await data.org();
    const freeTeam = await data.team(uncappedOrg.id);
    const free = await as(() => setBudget({ kind: "team", id: freeTeam.id, maxBudget: 5000, budgetDuration: "" }));
    assert.equal(free.budget.maxBudget, 5000);
  } finally {
    await data.cleanup();
  }
});

test("company users set budgets only inside their company and never on companies or console users", async () => {
  const data = new TestData();
  try {
    const home = await data.org();
    const away = await data.org();
    const homeTeam = await data.team(home.id);
    const awayTeam = await data.team(away.id);
    const user = await data.user({ orgId: home.id });
    const manager = sessionOf(user, { permissions: BUDGET_ADMIN });
    const as = <T>(fn: () => Promise<T>) => runAsPrincipal(manager, fn);

    await assert.rejects(as(() => setBudget({ kind: "org", id: home.id, maxBudget: 10, budgetDuration: "" })), failsWith("PLATFORM_ONLY"));
    await assert.rejects(as(() => setBudget({ kind: "user", id: user.id, maxBudget: 10, budgetDuration: "" })), failsWith("PLATFORM_ONLY"));
    await assert.rejects(as(() => addBoost({ kind: "org", id: home.id, amount: 5, hours: 1 })), failsWith("PLATFORM_ONLY"));
    await assert.rejects(as(() => saveBudgetAlerts([50, 90])), failsWith("PLATFORM_ONLY"));
    await assert.rejects(as(() => setBudget({ kind: "team", id: awayTeam.id, maxBudget: 10, budgetDuration: "" })), failsWith("NOT_FOUND"));
    assert.equal(Number((await prisma.team.findUniqueOrThrow({ where: { id: awayTeam.id } })).maxBudget), 0);

    const set = await as(() => setBudget({ kind: "team", id: homeTeam.id, maxBudget: 10, budgetDuration: "" }));
    assert.equal(set.budget.maxBudget, 10);
  } finally {
    await data.cleanup();
  }
});

test("console-user budgets change only for people the caller may manage", async () => {
  const data = new TestData();
  const role = await prisma.role.create({
    data: { name: uniqueName("role"), permissions: ["budgets:manage", "users:manage"] },
  });
  try {
    const owner = await data.user({ isOwner: true });
    const self = await data.user();
    const stronger = await data.user();
    const weaker = await data.user();
    await prisma.user.update({ where: { id: stronger.id }, data: { roleId: role.id } });
    const manager = sessionOf(self, { permissions: BUDGET_ADMIN });
    const as = <T>(fn: () => Promise<T>) => runAsPrincipal(manager, fn);

    for (const target of [owner, self, stronger]) {
      await assert.rejects(as(() => setBudget({ kind: "user", id: target.id, maxBudget: 10, budgetDuration: "" })), failsWith("FORBIDDEN"));
      await assert.rejects(as(() => addBoost({ kind: "user", id: target.id, amount: 5, hours: 1 })), failsWith("FORBIDDEN"));
    }
    assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).maxBudget), 0);

    const set = await as(() => setBudget({ kind: "user", id: weaker.id, maxBudget: 10, budgetDuration: "" }));
    assert.equal(set.budget.maxBudget, 10);

    const asOwner = <T>(fn: () => Promise<T>) => runAsPrincipal(sessionOf(owner), fn);
    const capped = await asOwner(() => setBudget({ kind: "user", id: stronger.id, maxBudget: 20, budgetDuration: "" }));
    assert.equal(capped.budget.maxBudget, 20);
    const boosted = await asOwner(() => addBoost({ kind: "user", id: stronger.id, amount: 5, hours: 1 }));
    await assert.rejects(as(() => removeBoost(boosted.budget.boosts[0].id)), failsWith("FORBIDDEN"));
  } finally {
    await data.cleanup();
    await prisma.role.delete({ where: { id: role.id } });
  }
});

test("temporary boosts need a capped budget and stay inside the caller's company", async () => {
  const data = new TestData();
  try {
    const home = await data.org();
    const away = await data.org();
    const capped = await data.team(home.id, { maxBudget: 20 });
    const uncapped = await data.team(home.id);
    const awayTeam = await data.team(away.id, { maxBudget: 20 });
    const admin = sessionOf(await data.user(), { permissions: BUDGET_ADMIN });
    const manager = sessionOf(await data.user({ orgId: home.id }), { permissions: BUDGET_ADMIN });

    await assert.rejects(
      runAsPrincipal(admin, () => addBoost({ kind: "team", id: uncapped.id, amount: 5, hours: 2 })),
      failsWith("BUDGET_NOT_CAPPED"),
    );
    const boosted = await runAsPrincipal(admin, () => addBoost({ kind: "team", id: capped.id, amount: 5, hours: 2 }));
    assert.equal(boosted.budget.boost, 5);
    const awayBoost = await runAsPrincipal(admin, () => addBoost({ kind: "team", id: awayTeam.id, amount: 5, hours: 2 }));

    await assert.rejects(
      runAsPrincipal(manager, () => removeBoost(awayBoost.budget.boosts[0].id)),
      failsWith("NOT_FOUND"),
    );
    assert.equal(await prisma.tempBudget.count({ where: { entityId: awayTeam.id } }), 1);
    const removed = await runAsPrincipal(manager, () => removeBoost(boosted.budget.boosts[0].id));
    assert.equal(removed.budget.boost, 0);
  } finally {
    await data.cleanup();
  }
});

test("key budgets are limited to keys the caller can see", async () => {
  const data = new TestData();
  try {
    const home = await data.org();
    const self = await data.user({ orgId: home.id });
    const colleague = await data.user({ orgId: home.id });
    const ownKey = await data.key({ userId: self.id, orgId: home.id });
    const colleagueKey = await data.key({ userId: colleague.id, orgId: home.id });
    const ownKeysOnly = sessionOf(self, { permissions: ["budgets:manage", "keys:read"] });
    const allKeys = sessionOf(await data.user({ orgId: home.id }), { permissions: BUDGET_ADMIN });

    await assert.rejects(
      runAsPrincipal(ownKeysOnly, () => setBudget({ kind: "key", id: colleagueKey.id, maxBudget: 5, budgetDuration: "" })),
      failsWith("NOT_FOUND"),
    );
    const own = await runAsPrincipal(ownKeysOnly, () => setBudget({ kind: "key", id: ownKey.id, maxBudget: 5, budgetDuration: "" }));
    assert.equal(own.budget.maxBudget, 5);
    const other = await runAsPrincipal(allKeys, () =>
      setBudget({ kind: "key", id: colleagueKey.id, maxBudget: 6, budgetDuration: "" }),
    );
    assert.equal(other.budget.maxBudget, 6);
  } finally {
    await data.cleanup();
  }
});

test("budget changes need budgets:manage", async () => {
  const data = new TestData();
  try {
    const org = await data.org();
    const team = await data.team(org.id, { maxBudget: 10 });
    const reader = sessionOf(await data.user(), { permissions: ["tenancy:read", "spend:read-all"] });
    const calls: (() => Promise<unknown>)[] = [
      () => setBudget({ kind: "team", id: team.id, maxBudget: 5, budgetDuration: "" }),
      () => addBoost({ kind: "team", id: team.id, amount: 5, hours: 1 }),
      () => removeBoost("missing"),
      () => saveBudgetAlerts([50]),
    ];
    for (const call of calls) {
      await assert.rejects(runAsPrincipal(reader, call), (err: unknown) => err instanceof AuthError && err.code === "FORBIDDEN");
    }
    assert.equal(Number((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).maxBudget), 10);
  } finally {
    await data.cleanup();
  }
});
