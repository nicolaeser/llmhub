import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { countNewLogs, loadLogs } from "@/lib/gateway/request-logs/explorer";
import { loadUsage } from "@/lib/usage/dashboard";
import { closeDatabase, uniqueName } from "./support/database";
import { sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

test("usage and log filters outside the caller's spend scope return nothing instead of the caller's own rows", async () => {
  const data = new TestData();
  const model = uniqueName("model");
  try {
    const home = await data.org();
    const away = await data.org();
    const homeTeam = await data.team(home.id);
    const awayTeam = await data.team(away.id);
    const companyUser = await data.user({ orgId: home.id });
    const platformUser = await data.user();
    const other = await data.user();
    const slices = [
      { orgId: home.id, teamId: homeTeam.id, keyId: uniqueName("key"), userId: companyUser.id, requests: 3 },
      { orgId: away.id, teamId: awayTeam.id, keyId: uniqueName("key"), userId: other.id, requests: 5 },
      { orgId: "", teamId: "", keyId: uniqueName("key"), userId: platformUser.id, requests: 7 },
    ];
    const [homeSlice, awaySlice, platformSlice] = slices;
    await prisma.usageDaily.createMany({
      data: slices.map((slice) => ({ ...slice, day: today(), model, cost: slice.requests })),
    });
    for (const { requests, ...tenant } of slices) {
      await prisma.requestLog.createMany({
        data: Array.from({ length: requests }, () => ({ ...tenant, model, status: 200 })),
      });
      await prisma.spendEvent.create({ data: { ...tenant, model, cost: 1 } });
    }

    const company = sessionOf(companyUser, { permissions: ["spend:read", "spend:read-all"] });
    const usageAs = (session: typeof company, filters: Record<string, string>) =>
      runAsPrincipal(session, () => loadUsage({ days: 7, model, ...filters }));
    const logsAs = (session: typeof company, filters: Record<string, string>) =>
      runAsPrincipal(session, () => loadLogs({ filters: { model, ...filters } }));

    assert.equal((await usageAs(company, {})).count, homeSlice.requests);
    assert.equal((await usageAs(company, { orgId: home.id })).count, homeSlice.requests);
    assert.equal((await usageAs(company, { orgId: away.id })).count, 0);
    assert.equal((await usageAs(company, { teamId: awayTeam.id })).count, 0);
    assert.equal((await usageAs(company, { keyId: awaySlice.keyId })).count, 0);
    assert.equal((await logsAs(company, { keyId: awaySlice.keyId })).requestTotal, 0);
    assert.equal((await logsAs(company, { userId: other.id })).requestTotal, 0);
    assert.equal((await logsAs(company, {})).requestTotal, homeSlice.requests);

    const ownOnly = sessionOf(platformUser, { permissions: ["spend:read"] });
    assert.equal((await usageAs(ownOnly, {})).count, platformSlice.requests);
    assert.equal((await usageAs(ownOnly, { userId: platformUser.id })).count, platformSlice.requests);
    assert.equal((await usageAs(ownOnly, { userId: other.id })).count, 0);
    assert.equal((await usageAs(ownOnly, { orgId: away.id })).count, 0);
    const foreignLogs = await logsAs(ownOnly, { userId: other.id });
    assert.equal(foreignLogs.requestTotal, 0);
    assert.equal(foreignLogs.spendTotal, 0);
    assert.equal(
      (
        await runAsPrincipal(ownOnly, () =>
          countNewLogs({ since: new Date(0).toISOString(), filters: { model, userId: other.id } }),
        )
      ).count,
      0,
    );
    assert.equal((await logsAs(ownOnly, { userId: platformUser.id })).requestTotal, platformSlice.requests);

    const reader = sessionOf(platformUser, { permissions: ["spend:read", "spend:read-all"] });
    assert.equal((await usageAs(reader, {})).count, homeSlice.requests + awaySlice.requests + platformSlice.requests);
    assert.equal((await usageAs(reader, { orgId: away.id })).count, awaySlice.requests);
    assert.equal((await usageAs(reader, { userId: other.id })).count, awaySlice.requests);
    const otherLogs = await logsAs(reader, { userId: other.id });
    assert.equal(otherLogs.requestTotal, awaySlice.requests);
    assert.equal(otherLogs.spendTotal, 1);
  } finally {
    await prisma.usageDaily.deleteMany({ where: { model } });
    await prisma.requestLog.deleteMany({ where: { model } });
    await prisma.spendEvent.deleteMany({ where: { model } });
    await data.cleanup();
  }
});
