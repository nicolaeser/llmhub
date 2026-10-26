import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { PERMISSIONS } from "@/lib/auth/permissions";
import type { AuthenticatedSession } from "@/types/auth";
import type { GlobalWithWorkerBoot } from "@/types/jobs";

delete process.env.REDIS_URL;

function manager(): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "ops", email: "ops@example.com", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions: [PERMISSIONS.PROVIDERS_READ, PERMISSIONS.PROVIDERS_MANAGE],
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

function storedProvider(newModels: string) {
  return {
    id: "p1",
    name: "Local",
    kind: "openai_compat",
    baseUrl: "https://local.example.test/v1",
    apiKey: "",
    discovered: [],
    zdr: false,
    retentionDays: null,
    region: "",
    noTraining: false,
    enabled: true,
    restricted: false,
    internal: false,
    newModels,
  };
}

function catalogTimers() {
  return (globalThis as GlobalWithWorkerBoot).__llmhubCatalogTimers ?? new Map();
}

afterEach(async () => {
  const { stopLocalCatalogTasks } = await import("@/lib/gateway/catalog/catalog-tasks");
  stopLocalCatalogTasks();
});

test("a new provider stores the chosen handling of new models and rejects unknown choices", async () => {
  const { createProvider } = await import("@/lib/providers/connections");
  recordedPrisma.reset();
  const session = manager();
  const body = { name: "Local", kind: "openai_compat", baseUrl: "https://local.example.test/v1", apiKey: "sk-local" };

  const created = await runAsPrincipal(session, () => createProvider({ ...body, newModels: "disabled" }));
  const [create] = recordedPrisma.called("providerConnection", "create");
  assert.equal((create?.args as { data: { newModels: string } }).data.newModels, "disabled");
  assert.equal(created.provider.newModels, "disabled");
  assert.ok(catalogTimers().has(`catalog-provider-${created.provider.id}`));

  recordedPrisma.reset();
  await runAsPrincipal(session, () => createProvider(body));
  const [fallback] = recordedPrisma.called("providerConnection", "create");
  assert.equal((fallback?.args as { data: { newModels: string } }).data.newModels, "auto");

  recordedPrisma.reset();
  await assert.rejects(
    runAsPrincipal(session, () => createProvider({ ...body, newModels: "everything" as never })),
    /VALIDATION/,
  );
  assert.equal(recordedPrisma.called("providerConnection", "create").length, 0);
});

test("changing how a provider handles new models rebuilds the catalog without fetching the provider again", async () => {
  const { updateProvider } = await import("@/lib/providers/connections");
  const session = manager();
  recordedPrisma.reset({
    providerConnection: {
      findUnique: () => storedProvider("auto"),
      update: (args: { data: { newModels?: string } }) => storedProvider(args.data.newModels ?? "auto"),
    },
  });
  const updated = await runAsPrincipal(session, () =>
    updateProvider({ id: "p1", name: "", baseUrl: "", apiKey: "", newModels: "active" }),
  );
  assert.equal(updated.provider.newModels, "active");
  assert.ok(catalogTimers().has("catalog-rebuild"));
  assert.equal(catalogTimers().has("catalog-provider-p1"), false);
  const [audit] = recordedPrisma.called("gatewayAuditLog", "create");
  const row = (audit?.args as { data: { beforeJson: string; afterJson: string } }).data;
  assert.equal(JSON.parse(row.beforeJson).newModels, "auto");
  assert.equal(JSON.parse(row.afterJson).newModels, "active");

  const { stopLocalCatalogTasks } = await import("@/lib/gateway/catalog/catalog-tasks");
  stopLocalCatalogTasks();
  await runAsPrincipal(session, () => updateProvider({ id: "p1", name: "", baseUrl: "", apiKey: "" }));
  assert.equal(catalogTimers().size, 0);
});

test("the management API accepts and returns the handling of new models", async () => {
  const { providerCreateSchema, providerUpdateSchema } = await import("@/schemas/management");
  const { serializeProvider } = await import("@/lib/management/serialize");
  const { publicProvider } = await import("@/lib/providers/connections");
  assert.equal(providerCreateSchema.parse({ kind: "openai" }).new_models, "auto");
  assert.equal(providerCreateSchema.parse({ kind: "openai", new_models: "active" }).new_models, "active");
  assert.equal(providerCreateSchema.safeParse({ kind: "openai", new_models: "on" }).success, false);
  assert.deepEqual(providerUpdateSchema.parse({ new_models: "disabled" }), { new_models: "disabled" });
  const view = publicProvider(storedProvider("disabled"));
  assert.equal(serializeProvider(view).new_models, "disabled");
  assert.equal(publicProvider(storedProvider("legacy")).newModels, "auto");
});
