import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import type { AuthenticatedSession, Permission } from "@/types/auth";

const manager: AuthenticatedSession = {
  error: false,
  sessionId: "s1",
  user: { id: "u-self", username: "operator", email: "operator@example.com", orgId: null } as AuthenticatedSession["user"],
  isOwner: false,
  role: null,
  permissions: ["models:read", "models:manage"] satisfies Permission[],
  secondFactor: "TOTP",
  ipAddress: null,
  userAgent: null,
  workspaceOrgId: null,
};

function presetRow(providerIds: string[]) {
  return {
    id: "tpl-1",
    name: "EU only",
    description: "",
    models: [],
    patterns: [],
    providerIds,
    regions: ["eu"],
    zdrOnly: false,
    noTrainingOnly: false,
    maxRetentionDays: null,
    _count: { keys: 2 },
  };
}

function handlers(stored: string[], existing: string[]) {
  return {
    modelTemplate: {
      findUnique: () => presetRow(stored),
      update: (args: never) => presetRow((args as { data: { providerIds: string[] } }).data.providerIds),
    },
    providerConnection: {
      count: (args: never) =>
        (args as { where: { id: { in: string[] } } }).where.id.in.filter((id) => existing.includes(id)).length,
    },
  };
}

const draft = { id: "tpl-1", name: "EU only", description: "", regions: ["eu"] };

test("saving a preset keeps provider ids it already stores even after those providers were removed", async () => {
  const { updateTemplate } = await import("@/lib/models/templates");
  recordedPrisma.reset(handlers(["gone", "live"], ["live"]));
  const kept = await runAsPrincipal(manager, () => updateTemplate({ ...draft, providerIds: ["gone", "live"] }));
  assert.deepEqual(kept.template.providerIds, ["gone", "live"]);
  assert.equal(recordedPrisma.called("providerConnection", "count").length, 0);

  recordedPrisma.reset(handlers(["gone"], ["live"]));
  const added = await runAsPrincipal(manager, () => updateTemplate({ ...draft, providerIds: ["gone", "live"] }));
  assert.deepEqual(added.template.providerIds, ["gone", "live"]);
  assert.deepEqual(
    (recordedPrisma.called("providerConnection", "count")[0]?.args as { where: { id: { in: string[] } } }).where.id.in,
    ["live"],
  );
});

test("saving a preset still rejects provider ids that are new and unknown", async () => {
  const { createTemplate, updateTemplate } = await import("@/lib/models/templates");
  recordedPrisma.reset(handlers(["gone"], ["live"]));
  await assert.rejects(
    runAsPrincipal(manager, () => updateTemplate({ ...draft, providerIds: ["gone", "typo"] })),
    /NOT_FOUND/,
  );
  assert.equal(recordedPrisma.called("modelTemplate", "update").length, 0);

  recordedPrisma.reset(handlers([], ["live"]));
  await assert.rejects(
    runAsPrincipal(manager, () => createTemplate({ name: "EU only", providerIds: ["gone"] })),
    /NOT_FOUND/,
  );
  assert.equal(recordedPrisma.called("modelTemplate", "create").length, 0);
});
