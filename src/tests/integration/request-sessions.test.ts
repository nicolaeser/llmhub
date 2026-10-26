import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { loadLogs } from "@/lib/gateway/request-logs/explorer";
import { listSessions, loadLogSession, loadLogSessions } from "@/lib/gateway/request-logs/sessions";
import { parseLogFilters } from "@/lib/gateway/request-logs/request-log-query";
import { closeDatabase, uniqueName } from "./support/database";
import { sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

test("agent sessions sum their requests per session, key, and user inside the viewer's spend scope", async () => {
  const data = new TestData();
  const run = uniqueName("run");
  const other = uniqueName("run");
  const opus = uniqueName("opus");
  const haiku = uniqueName("haiku");
  const gpt = uniqueName("gpt");
  const keyA = uniqueName("key");
  const keyB = uniqueName("key");
  const providerIds: string[] = [];
  try {
    const home = await data.org();
    const away = await data.org();
    const companyUser = await data.user({ orgId: home.id });
    const awayUser = await data.user({ orgId: away.id });
    const platformUser = await data.user();
    const [first, second, apiKey] = await Promise.all(
      ["claude", "claude", "openai"].map((kind) =>
        prisma.providerConnection.create({ data: { name: uniqueName(kind), kind } }),
      ),
    );
    providerIds.push(first!.id, second!.id, apiKey!.id);

    const started = Date.now() - 3_600_000;
    const at = (seconds: number) => new Date(started + seconds * 1000);
    const homeRun = { orgId: home.id, keyId: keyA, userId: companyUser.id, sessionId: run, agent: "claude_code" };
    await prisma.requestLog.createMany({
      data: [
        { ...homeRun, createdAt: at(0), latencyMs: 2_000, model: opus, provider: "claude", providerId: first!.id, status: 200, cost: 0.5, promptTokens: 100, completionTokens: 10 },
        { ...homeRun, createdAt: at(10), latencyMs: 300, model: haiku, provider: "claude", providerId: first!.id, status: 200, cost: 0.5, promptTokens: 100, completionTokens: 10 },
        { ...homeRun, createdAt: at(20), latencyMs: 300, model: gpt, provider: "openai", providerId: apiKey!.id, status: 200, cost: 0.5, promptTokens: 100, completionTokens: 10 },
        { ...homeRun, createdAt: at(30), latencyMs: 300, model: opus, provider: "claude", providerId: second!.id, status: 429, outcome: "error", cost: 0.5, promptTokens: 100, completionTokens: 10 },
        { ...homeRun, createdAt: at(40), latencyMs: 300, model: opus, provider: "claude", providerId: second!.id, status: 200, cost: 0.5, promptTokens: 100, completionTokens: 10, cacheReadTokens: 40 },
        { ...homeRun, createdAt: at(50), latencyMs: 300, model: opus, provider: "claude", providerId: first!.id, status: 499, outcome: "cancelled", cost: 0.5, promptTokens: 100, completionTokens: 10 },
        { orgId: away.id, keyId: keyB, userId: awayUser.id, sessionId: run, createdAt: at(5), model: opus, status: 200, cost: 9 },
        { orgId: away.id, keyId: keyB, userId: awayUser.id, sessionId: run, createdAt: at(15), model: opus, status: 200, cost: 9 },
        { orgId: home.id, keyId: keyA, userId: companyUser.id, sessionId: other, agent: "codex", createdAt: new Date(Date.now() - 60_000), model: gpt, status: 200, cost: 1 },
        { orgId: home.id, keyId: keyA, userId: companyUser.id, sessionId: "", createdAt: at(1), model: gpt, status: 200, cost: 7 },
      ],
    });

    const company = sessionOf(companyUser, { permissions: ["spend:read", "spend:read-all"] });
    const platform = sessionOf(platformUser, { permissions: ["spend:read", "spend:read-all", "providers:read"] });
    const listAs = (session: typeof company, filters: Record<string, string>) =>
      runAsPrincipal(session, () => loadLogSessions({ filters }));

    const own = await listAs(company, { keyId: keyA });
    assert.equal(own.total, 2);
    assert.equal(own.capped, false);
    assert.deepEqual(own.sessions.map((row) => row.sessionId), [other, run]);
    const [latest, traced] = own.sessions;
    assert.equal(latest!.active, true);
    assert.equal(latest!.agent, "codex");
    assert.equal(traced!.active, false);
    assert.equal(traced!.agent, "claude_code");
    assert.equal(traced!.requests, 6);
    assert.equal(traced!.errors, 1);
    assert.equal(traced!.cost, 3);
    assert.equal(traced!.promptTokens, 600);
    assert.equal(traced!.completionTokens, 60);
    assert.equal(traced!.cacheReadTokens, 40);
    assert.equal(traced!.accounts, 2);
    assert.equal(traced!.accountSwitches, 2);
    assert.equal(traced!.durationMs, 52_000);
    assert.equal(traced!.startedAt, new Date(started - 2_000).toISOString());
    assert.equal(traced!.lastAt, at(50).toISOString());
    assert.deepEqual(traced!.models, [
      { model: opus, requests: 4 },
      ...[
        { model: gpt, requests: 1 },
        { model: haiku, requests: 1 },
      ].sort((left, right) => left.model.localeCompare(right.model)),
    ]);
    assert.equal(traced!.keyId, keyA);
    assert.equal(traced!.userLabel, companyUser.username);

    assert.deepEqual(own.sort, { by: "recent", direction: "desc" });
    assert.equal(own.totals.active, 1);
    assert.equal(own.totals.requests, 7);
    assert.equal(own.totals.errors, 1);
    assert.equal(own.totals.cost, 4);
    assert.equal(own.totals.cacheReadTokens, 40);
    const byCost = await runAsPrincipal(company, () =>
      loadLogSessions({ filters: { keyId: keyA }, sort: { by: "cost", direction: "desc" } }),
    );
    assert.deepEqual(byCost.sessions.map((row) => row.sessionId), [run, other]);
    const fewestRequests = await runAsPrincipal(company, () =>
      loadLogSessions({ filters: { keyId: keyA }, sort: { by: "requests", direction: "asc" } }),
    );
    assert.deepEqual(fewestRequests.sessions.map((row) => row.sessionId), [other, run]);

    assert.deepEqual((await listAs(company, { session: run })).sessions.map((row) => row.keyId), [keyA]);
    assert.deepEqual(
      (await listAs(platform, { session: run })).sessions.map((row) => row.keyId).sort(),
      [keyA, keyB].sort(),
    );
    const onlyHaiku = await listAs(company, { model: haiku });
    assert.equal(onlyHaiku.total, 1);
    assert.equal(onlyHaiku.sessions[0]!.requests, 1);
    assert.equal(onlyHaiku.sessions[0]!.accountSwitches, 0);
    assert.equal(
      (await runAsPrincipal(company, () => loadLogs({ filters: { session: run, keyId: keyA } }))).requestTotal,
      6,
    );

    const ref = { sessionId: run, keyId: keyA, userId: companyUser.id };
    const timeline = await runAsPrincipal(company, () => loadLogSession({ ref }));
    assert.equal(timeline.total, 6);
    assert.equal(timeline.session.accountSwitches, 2);
    assert.deepEqual(timeline.requests.map((row) => row.model), [opus, haiku, gpt, opus, opus, opus]);
    assert.deepEqual(timeline.requests.map((row) => row.accountSwitch), [false, false, false, true, false, true]);
    assert.deepEqual(timeline.requests.map((row) => row.account), [1, 1, 2, 3, 3, 1]);
    assert.equal(timeline.requests[0]!.offsetMs, 2_000);
    assert.deepEqual(timeline.accounts.map((account) => account.label), ["", "", ""]);
    assert.deepEqual(timeline.accounts.map((account) => account.requests), [3, 1, 2]);

    const named = await runAsPrincipal(platform, () => loadLogSession({ ref }));
    assert.deepEqual(
      named.accounts.map((account) => account.label),
      [first!.name, apiKey!.name, second!.name],
    );

    await assert.rejects(
      runAsPrincipal(company, () => loadLogSession({ ref: { sessionId: run, keyId: keyB, userId: awayUser.id } })),
      /NOT_FOUND/,
    );
    await assert.rejects(runAsPrincipal(company, () => loadLogSession({ ref: { sessionId: "" } })), /VALIDATION/);

    const exported = await listSessions({ orgId: home.id }, parseLogFilters({ keyId: keyA }), 0, 1_000);
    assert.deepEqual(exported.map((row) => row.sessionId), [other, run]);
  } finally {
    await prisma.requestLog.deleteMany({ where: { OR: [{ sessionId: { in: [run, other] } }, { model: { in: [opus, haiku, gpt] } }] } });
    await prisma.providerConnection.deleteMany({ where: { id: { in: providerIds } } });
    await data.cleanup();
  }
});
