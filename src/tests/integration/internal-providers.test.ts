import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { isRouterError } from "@/lib/gateway/core";
import { loadModelPolicies } from "@/lib/gateway/access/model-access";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { pricedModels } from "@/lib/gateway/catalog/model-pricing";
import { withDeployment } from "@/lib/gateway/dispatch/chat";
import { loadGroup } from "@/lib/gateway/routing/runtime";
import { enabledModelChoices } from "@/lib/models/aliases";
import { createProvider, updateProvider } from "@/lib/providers/connections";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";

after(closeDatabase);

globalThis.fetch = (async () => Response.json({ error: { message: "offline" } }, { status: 401 })) as unknown as typeof fetch;

const pick = async (dep: { id: string }) => dep.id;

async function auditAfter(action: string, objectId: string) {
  const row = await prisma.gatewayAuditLog.findFirstOrThrow({ where: { action, objectId }, orderBy: { createdAt: "desc" } });
  return {
    before: JSON.parse(row.beforeJson || "{}") as Record<string, unknown>,
    after: JSON.parse(row.afterJson || "{}") as Record<string, unknown>,
  };
}

test("an internal provider keeps its flag and its routes stay off the public pools", async () => {
  const owner = await ownerSession();
  const names = { private: uniqueName("private"), mixed: uniqueName("mixed") };
  const ids: string[] = [];
  try {
    const created = await runAsPrincipal(owner, () =>
      createProvider({ name: uniqueName("private"), kind: "openai_compat", baseUrl: "https://private.test/v1", apiKey: "sk-private", internal: true }),
    );
    stopLocalCatalogTasks();
    ids.push(created.provider.id);
    assert.equal(created.provider.internal, true);
    assert.equal((await prisma.providerConnection.findUniqueOrThrow({ where: { id: created.provider.id } })).internal, true);
    assert.equal((await auditAfter("provider.connect", created.provider.id)).after.internal, true);

    const opened = await runAsPrincipal(owner, () =>
      updateProvider({ id: created.provider.id, name: "", baseUrl: "", apiKey: "", internal: false }),
    );
    stopLocalCatalogTasks();
    assert.equal(opened.provider.internal, false);
    const toggled = await auditAfter("provider.update", created.provider.id);
    assert.deepEqual([toggled.before.internal, toggled.after.internal], [true, false]);
    const unchanged = await runAsPrincipal(owner, () =>
      updateProvider({ id: created.provider.id, name: "", baseUrl: "", apiKey: "", enabled: true }),
    );
    assert.equal(unchanged.provider.internal, false);
    await runAsPrincipal(owner, () => updateProvider({ id: created.provider.id, name: "", baseUrl: "", apiKey: "", internal: true }));
    stopLocalCatalogTasks();

    const open = await prisma.providerConnection.create({
      data: { name: uniqueName("public"), kind: "openai_compat", baseUrl: "https://public.test/v1" },
    });
    ids.push(open.id);
    await prisma.modelGroup.create({
      data: {
        alias: names.private,
        deployments: { create: [{ kind: "openai_compat", providerId: created.provider.id, model: "embed" }] },
      },
    });
    await prisma.modelGroup.create({
      data: {
        alias: names.mixed,
        strategy: "priority",
        deployments: {
          create: [
            { kind: "openai_compat", providerId: created.provider.id, model: "chat", weight: 10 },
            { kind: "openai_compat", providerId: open.id, model: "chat", weight: 1 },
          ],
        },
      },
    });

    const group = await loadGroup(names.private);
    assert.deepEqual(group.mapped.map((dep) => dep.provider?.internal), [true]);
    await assert.rejects(withDeployment([names.private], {}, pick), (err: unknown) => isRouterError(err, "unknown_group"));
    await assert.rejects(
      withDeployment([names.private], {}, pick, { pool: "subscription" }),
      (err: unknown) => isRouterError(err, "unknown_group"),
    );
    const [privateRoute] = group.mapped;
    assert.equal((await withDeployment([names.private], {}, pick, { pool: "internal" })).result, privateRoute!.id);
    const mixed = await loadGroup(names.mixed);
    const publicRoute = mixed.mapped.find((dep) => dep.provider?.id === open.id)!;
    const internalRoute = mixed.mapped.find((dep) => dep.provider?.id === created.provider.id)!;
    assert.equal((await withDeployment([names.mixed], {}, pick)).result, publicRoute.id);
    assert.equal((await withDeployment([names.mixed], {}, pick, { pool: "internal" })).result, internalRoute.id);

    const priced = await pricedModels(new Date(), [names.private, names.mixed]);
    assert.deepEqual(priced.find((model) => model.alias === names.private)?.pools, ["internal"]);
    assert.deepEqual(priced.find((model) => model.alias === names.mixed)?.pools.sort(), ["api", "internal"]);
    const policies = (await loadModelPolicies()).map((policy) => policy.alias);
    assert.equal(policies.includes(names.private), false);
    assert.equal(policies.includes(names.mixed), true);
    const choices = await enabledModelChoices();
    assert.deepEqual(choices.find((choice) => choice.alias === names.private)?.pools, ["internal"]);
  } finally {
    stopLocalCatalogTasks();
    await prisma.modelGroup.deleteMany({ where: { alias: { in: Object.values(names) } } });
    await prisma.providerConnection.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});

test("sign-in connections refuse the internal flag and keep their pool", async () => {
  const owner = await ownerSession();
  const plan = await prisma.providerConnection.create({ data: { name: uniqueName("plan"), kind: "claude" } });
  try {
    await assert.rejects(
      runAsPrincipal(owner, () => updateProvider({ id: plan.id, name: "", baseUrl: "", apiKey: "", internal: true })),
      /INTERNAL_SIGN_IN/,
    );
    await assert.rejects(
      runAsPrincipal(owner, () => createProvider({ name: "", kind: "claude", baseUrl: "", apiKey: "", internal: true })),
      /INTERNAL_SIGN_IN/,
    );
    assert.equal((await prisma.providerConnection.findUniqueOrThrow({ where: { id: plan.id } })).internal, false);
    assert.equal(await prisma.gatewayAuditLog.count({ where: { objectId: plan.id } }), 0);
  } finally {
    await prisma.providerConnection.deleteMany({ where: { id: plan.id } });
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});
