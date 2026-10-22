import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { loadLogs } from "@/lib/gateway/request-logs/explorer";
import { testFeatureModel } from "@/lib/models/feature-model-test";
import { createProvider } from "@/lib/providers/connections";
import { loadUsage } from "@/lib/usage/dashboard";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";
import { sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

const upstream: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  upstream.push(url);
  if (url.endsWith("/embeddings")) {
    return Response.json({ object: "list", data: [{ index: 0, embedding: [1, 0, 0] }], usage: { prompt_tokens: 4, total_tokens: 4 } });
  }
  return Response.json({ error: { message: "offline" } }, { status: 401 });
}) as typeof fetch;

test("system calls are metered with empty tenancy, store no content, and stay out of company views", async () => {
  const owner = await ownerSession();
  const data = new TestData();
  const alias = uniqueName("embed");
  const providerIds: string[] = [];
  try {
    const created = await runAsPrincipal(owner, () =>
      createProvider({ name: uniqueName("private"), kind: "openai_compat", baseUrl: "https://private-embed.test/v1", apiKey: "sk-private", internal: true }),
    );
    stopLocalCatalogTasks();
    providerIds.push(created.provider.id);
    await prisma.modelGroup.create({
      data: {
        alias,
        deployments: { create: [{ kind: "openai_compat", providerId: created.provider.id, model: "embed-small" }] },
      },
    });

    upstream.length = 0;
    const result = await runAsPrincipal(owner, () => testFeatureModel({ feature: "knowledge", role: "embedding", model: alias }));
    assert.deepEqual([result.ok, result.model, result.status], [true, alias, 200]);
    assert.deepEqual(upstream, ["https://private-embed.test/v1/embeddings"]);

    const usage = await prisma.usageDaily.findMany({ where: { model: alias } });
    assert.equal(usage.length, 1);
    const [row] = usage;
    assert.deepEqual(
      [row!.keyId, row!.userId, row!.memberId, row!.projectId, row!.teamId, row!.orgId],
      ["", "", "", "", "", ""],
    );
    assert.deepEqual([row!.requests, Number(row!.promptTokens)], [1, 4]);
    const spend = await prisma.spendEvent.findMany({ where: { model: alias } });
    assert.equal(spend.length, 1);
    assert.deepEqual([spend[0]!.keyId, spend[0]!.userId, spend[0]!.orgId], ["", "", ""]);
    const logs = await prisma.requestLog.findMany({ where: { model: alias }, include: { content: true } });
    assert.equal(logs.length, 1);
    assert.deepEqual(
      [logs[0]!.endpoint, logs[0]!.contentSkip, logs[0]!.content, logs[0]!.keyId, logs[0]!.userId, logs[0]!.orgId],
      ["internal:test:knowledge", "system", null, "", "", ""],
    );

    const home = await data.org();
    const companyUser = await data.user({ orgId: home.id });
    const platformUser = await data.user();
    const company = sessionOf(companyUser, { permissions: ["spend:read", "spend:read-all"] });
    const ownOnly = sessionOf(platformUser, { permissions: ["spend:read"] });
    const reader = sessionOf(platformUser, { permissions: ["spend:read", "spend:read-all"] });
    const usageAs = (session: typeof company, filters: Record<string, string> = {}) =>
      runAsPrincipal(session, () => loadUsage({ days: 7, model: alias, ...filters }));
    const logsAs = (session: typeof company) => runAsPrincipal(session, () => loadLogs({ filters: { model: alias } }));

    assert.equal((await usageAs(company)).count, 0);
    assert.equal((await usageAs(company, { orgId: "" })).count, 0);
    const companyLogs = await logsAs(company);
    assert.deepEqual([companyLogs.requestTotal, companyLogs.spendTotal], [0, 0]);
    assert.equal((await usageAs(ownOnly)).count, 0);
    assert.equal((await logsAs(ownOnly)).requestTotal, 0);

    const platform = await usageAs(reader);
    assert.equal(platform.count, 1);
    assert.deepEqual(platform.byUser.map((slice) => slice.name), ["system"]);
    assert.deepEqual(platform.byOrg.map((slice) => slice.name), ["system"]);
    const platformLogs = await logsAs(reader);
    assert.deepEqual([platformLogs.requestTotal, platformLogs.spendTotal], [1, 1]);
  } finally {
    stopLocalCatalogTasks();
    await prisma.usageDaily.deleteMany({ where: { model: alias } });
    await prisma.requestLog.deleteMany({ where: { model: alias } });
    await prisma.spendEvent.deleteMany({ where: { model: alias } });
    await prisma.modelGroup.deleteMany({ where: { alias } });
    await prisma.providerConnection.deleteMany({ where: { id: { in: providerIds } } });
    await data.cleanup();
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});
