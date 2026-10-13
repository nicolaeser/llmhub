import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { deleteProvider } from "@/lib/providers/connections";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";

after(closeDatabase);

async function provider(name: string) {
  return prisma.providerConnection.create({ data: { name: uniqueName(name), kind: "openrouter" } });
}

async function group(alias: string, routes: { providerId: string; model: string }[], extra: object = {}) {
  await prisma.modelGroup.create({
    data: {
      alias,
      ...extra,
      deployments: { create: routes.map((route) => ({ kind: "openrouter", ...route })) },
    },
  });
}

test("removing a provider takes its routes and catalog entries and only the groups the catalog owned", async () => {
  const owner = await ownerSession();
  const gone = await provider("gone");
  const kept = await provider("kept");
  const alias = (name: string) => uniqueName(name);
  const names = {
    plain: alias("plain"),
    custom: alias("custom"),
    target: alias("target"),
    caller: alias("caller"),
    shared: alias("shared"),
  };
  try {
    await group(names.plain, [{ providerId: gone.id, model: "openai/gpt-4o" }]);
    await group(names.custom, [{ providerId: gone.id, model: "openai/gpt-4o" }], { billingMode: "custom" });
    await group(names.target, [{ providerId: gone.id, model: "openai/gpt-4o-mini" }]);
    await group(names.caller, [{ providerId: kept.id, model: "openai/gpt-4o" }], { fallbackGroups: [names.target] });
    await group(names.shared, [
      { providerId: gone.id, model: "openai/gpt-4.1" },
      { providerId: kept.id, model: "openai/gpt-4.1" },
    ]);
    await prisma.catalogEntry.create({
      data: { providerId: gone.id, upstreamId: "openai/gpt-4o", alias: names.plain, source: "route" },
    });

    const result = await runAsPrincipal(owner, () => deleteProvider(gone.id));
    stopLocalCatalogTasks();

    assert.equal(result.removedRoutes, 4);
    assert.deepEqual(result.removedGroups, [names.plain]);
    assert.deepEqual([...result.emptyGroups].sort(), [names.custom, names.target].sort());
    assert.equal(await prisma.providerConnection.count({ where: { id: gone.id } }), 0);
    assert.equal(await prisma.catalogEntry.count({ where: { providerId: gone.id } }), 0);
    assert.equal(await prisma.modelGroup.count({ where: { alias: names.plain } }), 0);
    assert.equal(await prisma.modelGroup.count({ where: { alias: { in: [names.custom, names.target] } } }), 2);
    assert.deepEqual(
      (await prisma.deployment.findMany({ where: { groupAlias: names.shared } })).map((dep) => dep.providerId),
      [kept.id],
    );
    const audit = await prisma.gatewayAuditLog.findFirstOrThrow({
      where: { action: "provider.delete", objectId: gone.id },
    });
    assert.deepEqual(JSON.parse(audit.afterJson ?? "{}").removedGroups, [names.plain]);
  } finally {
    stopLocalCatalogTasks();
    await prisma.modelGroup.deleteMany({ where: { alias: { in: Object.values(names) } } });
    await prisma.providerConnection.deleteMany({ where: { id: { in: [gone.id, kept.id] } } });
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});
