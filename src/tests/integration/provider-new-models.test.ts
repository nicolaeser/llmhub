import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { catalogInputs } from "@/lib/gateway/catalog/catalog-entries";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { createProvider, updateProvider } from "@/lib/providers/connections";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";

after(closeDatabase);

globalThis.fetch = (async () => Response.json({ error: { message: "offline" } }, { status: 401 })) as unknown as typeof fetch;

test("a provider keeps its handling of new models and the catalog plans with it", async () => {
  const owner = await ownerSession();
  const ids: string[] = [];
  try {
    const created = await runAsPrincipal(owner, () =>
      createProvider({
        name: uniqueName("quiet"),
        kind: "openai_compat",
        baseUrl: "https://quiet.test/v1",
        apiKey: "sk-quiet",
        newModels: "disabled",
      }),
    );
    stopLocalCatalogTasks();
    ids.push(created.provider.id);
    assert.equal(created.provider.newModels, "disabled");
    const model = uniqueName("quiet-model");
    await prisma.providerConnection.update({
      where: { id: created.provider.id },
      data: { discovered: [{ id: model, name: model }] },
    });
    const planned = (await catalogInputs()).plan.entries.find((entry) => entry.providerId === created.provider.id);
    assert.equal(planned?.upstreamId, model);
    assert.equal(planned?.disabled, true);

    const updated = await runAsPrincipal(owner, () =>
      updateProvider({ id: created.provider.id, name: "", baseUrl: "", apiKey: "", newModels: "active" }),
    );
    stopLocalCatalogTasks();
    assert.equal(updated.provider.newModels, "active");
    const stored = await prisma.providerConnection.findUniqueOrThrow({ where: { id: created.provider.id } });
    assert.equal(stored.newModels, "active");
    const audit = await prisma.gatewayAuditLog.findFirstOrThrow({
      where: { action: "provider.update", objectId: created.provider.id },
      orderBy: { createdAt: "desc" },
    });
    assert.deepEqual(
      [JSON.parse(audit.beforeJson || "{}").newModels, JSON.parse(audit.afterJson || "{}").newModels],
      ["disabled", "active"],
    );
  } finally {
    stopLocalCatalogTasks();
    await prisma.providerConnection.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});
