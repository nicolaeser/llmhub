import assert from "node:assert/strict";
import test from "node:test";
import type { DeploymentRule } from "@/types/model-templates";

type FakeProvider = {
  id: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  zdr: boolean;
  retentionDays: number | null;
  region: string;
  noTraining: boolean;
};

const euZdr: FakeProvider = {
  id: "eu-zdr",
  kind: "openrouter_eu",
  baseUrl: "",
  apiKey: "",
  zdr: true,
  retentionDays: null,
  region: "eu",
  noTraining: true,
};
const usPlain: FakeProvider = { ...euZdr, id: "us-plain", kind: "openai", zdr: false, region: "us", noTraining: false };

function deployment(id: string, provider: FakeProvider | null, weight: number) {
  return {
    id,
    kind: provider?.kind ?? "openai_compat",
    baseUrl: provider ? "" : "https://local.example.test/v1",
    model: id,
    weight,
    costInput: 0,
    costOutput: 0,
    providerId: provider?.id ?? null,
    provider,
  };
}

const groups = new Map([
  [
    "claude",
    {
      alias: "claude",
      enabled: true,
      strategy: "priority",
      billingMode: "routed",
      priceInput: 0,
      priceOutput: 0,
      priceTimeZone: "UTC",
      priceWindows: [],
      overflowGroup: "",
      numRetries: 0,
      fallbackGroups: ["backup"],
      deployments: [deployment("claude-us", usPlain, 10), deployment("claude-eu", euZdr, 1)],
    },
  ],
  [
    "backup",
    {
      alias: "backup",
      enabled: true,
      strategy: "priority",
      billingMode: "routed",
      priceInput: 0,
      priceOutput: 0,
      priceTimeZone: "UTC",
      priceWindows: [],
      overflowGroup: "",
      numRetries: 0,
      fallbackGroups: [],
      deployments: [deployment("backup-local", null, 5), deployment("backup-us", usPlain, 1)],
    },
  ],
]);

(globalThis as { prisma?: unknown }).prisma = {
  modelGroup: {
    findUnique: async ({ where }: { where: { alias: string } }) => groups.get(where.alias) ?? null,
  },
};

const zdrOnly: DeploymentRule = { providerIds: [], regions: [], zdrOnly: true, noTrainingOnly: false, maxRetentionDays: null };
const usOnly: DeploymentRule = { providerIds: [], regions: ["us"], zdrOnly: false, noTrainingOnly: false, maxRetentionDays: null };

test("acquireGroup only hands out deployments that meet the caller's rules", async () => {
  const { acquireGroup, loadGroup } = await import("@/lib/gateway/runtime");
  const group = await loadGroup("claude");
  const open = await acquireGroup(group, undefined);
  assert.equal(open.dep.id, "claude-us");
  open.release();
  const limited = await acquireGroup(group, [zdrOnly]);
  assert.equal(limited.dep.id, "claude-eu");
  limited.release();
  const either = await acquireGroup(group, [usOnly, zdrOnly]);
  assert.equal(either.dep.id, "claude-us");
  either.release();
});

test("permittedDeployments drops custom endpoints under any data rule", async () => {
  const { loadGroup, permittedDeployments } = await import("@/lib/gateway/runtime");
  const backup = await loadGroup("backup");
  assert.deepEqual(
    permittedDeployments(backup.mapped, undefined).map((dep) => dep.id),
    ["backup-local", "backup-us"],
  );
  assert.deepEqual(permittedDeployments(backup.mapped, [usOnly]).map((dep) => dep.id), ["backup-us"]);
  assert.deepEqual(permittedDeployments(backup.mapped, [zdrOnly]), []);
});

test("fallback aliases inherit the rules of the alias the caller asked for", async () => {
  const { withDeployment } = await import("@/lib/gateway/chat");
  const used: string[] = [];
  const failing = async (dep: { id: string }) => {
    used.push(dep.id);
    throw new Error("upstream down");
  };

  await assert.rejects(withDeployment(["claude"], { claude: [usOnly] }, failing));
  assert.deepEqual(used, ["claude-us", "backup-us"]);

  used.length = 0;
  await assert.rejects(withDeployment(["claude"], { claude: [zdrOnly] }, failing));
  assert.deepEqual(used, ["claude-eu"]);

  used.length = 0;
  const served = await withDeployment(["claude"], {}, async (dep) => dep.id);
  assert.equal(served.result, "claude-us");
});
