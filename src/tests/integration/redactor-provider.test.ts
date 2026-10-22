import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import {
  REDACTOR_ALIAS,
  REDACTOR_DEPLOYMENT_ID,
  REDACTOR_PROVIDER_ID,
  syncRedactorProvider,
} from "@/lib/bootstrap/redactor-provider";
import { hiddenFrom } from "@/lib/gateway/routing/route-pool";
import { loadGroup } from "@/lib/gateway/routing/runtime";
import { assertModelRoles, featureModelChoices } from "@/lib/models/aliases";
import { closeDatabase } from "./support/database";

after(closeDatabase);

test("LLMHUB_REDACTOR_URL keeps one internal-only pii-tracer route and switches it off when unset", async () => {
  const before = {
    provider: await prisma.providerConnection.findUnique({ where: { id: REDACTOR_PROVIDER_ID } }),
    group: await prisma.modelGroup.findUnique({ where: { alias: REDACTOR_ALIAS } }),
    deployment: await prisma.deployment.findUnique({ where: { id: REDACTOR_DEPLOYMENT_ID } }),
  };
  try {
    await syncRedactorProvider("http://redactor.test:8080");
    await syncRedactorProvider("http://redactor.test:9090");
    const provider = await prisma.providerConnection.findUniqueOrThrow({ where: { id: REDACTOR_PROVIDER_ID } });
    assert.deepEqual([provider.kind, provider.baseUrl, provider.internal, provider.enabled], ["openai_compat", "http://redactor.test:9090", true, true]);
    assert.equal(await prisma.deployment.count({ where: { groupAlias: REDACTOR_ALIAS, providerId: REDACTOR_PROVIDER_ID } }), 1);

    const group = await loadGroup(REDACTOR_ALIAS);
    assert.equal(hiddenFrom("api", group.mapped), true);
    assert.equal(hiddenFrom("internal", group.mapped), false);
    const choice = (await featureModelChoices()).find((model) => model.alias === REDACTOR_ALIAS);
    assert.deepEqual([choice?.role, choice?.internal], ["redaction", true]);
    await assertModelRoles([{ alias: REDACTOR_ALIAS, role: "redaction" }]);

    await syncRedactorProvider(undefined);
    assert.equal((await prisma.providerConnection.findUniqueOrThrow({ where: { id: REDACTOR_PROVIDER_ID } })).enabled, false);
  } finally {
    if (before.deployment) {
      const { groupAlias, kind, baseUrl, model, providerId } = before.deployment;
      await prisma.deployment.update({ where: { id: REDACTOR_DEPLOYMENT_ID }, data: { groupAlias, kind, baseUrl, model, providerId } });
    } else {
      await prisma.deployment.deleteMany({ where: { id: REDACTOR_DEPLOYMENT_ID } });
    }
    if (!before.group) await prisma.modelGroup.deleteMany({ where: { alias: REDACTOR_ALIAS } });
    if (before.provider) {
      const { kind, baseUrl, internal, enabled } = before.provider;
      await prisma.providerConnection.update({ where: { id: REDACTOR_PROVIDER_ID }, data: { kind, baseUrl, internal, enabled } });
    } else {
      await prisma.providerConnection.deleteMany({ where: { id: REDACTOR_PROVIDER_ID } });
    }
  }
});
