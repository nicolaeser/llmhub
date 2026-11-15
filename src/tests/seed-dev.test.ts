import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { seedDevelopment, validateSeedTarget } from "../../scripts/seed-dev.mjs";
import { insertDevelopmentFixtures } from "../../scripts/seed-dev-fixtures.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const env = {
  NODE_ENV: "development" as const,
  DATABASE_URL: "postgresql://example:example@127.0.0.1:5433/llmhub_dev",
  APP_SECRET: "test-app-secret-aaaaaaaaaaaaaaaaaaaa",
};
const args = ["--reset-local=llmhub_dev"];

test("seed-dev refuses production before any subprocess or database work", async () => {
  let calls = 0;
  await assert.rejects(seedDevelopment({
    env: { ...env, NODE_ENV: "production" }, args,
    run: async () => { calls += 1; },
  }), /production resets are forbidden/);
  assert.equal(calls, 0);
  const result = spawnSync(process.execPath, ["scripts/seed-dev.mjs", ...args], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "invalid", APP_SECRET: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /production resets are forbidden/);
  assert.doesNotMatch(result.stdout + result.stderr, /Prisma|Loaded Prisma|datasource|example:example/);
});

test("seed-dev rejects unsafe or ambiguous targets without starting work", async () => {
  const targets = [
    "postgresql://example:example@db.example.test/llmhub_dev",
    "postgresql://example:example@postgres/llmhub_dev",
    "postgresql://example:example@192.168.1.2/llmhub_dev",
    "postgresql://example:example@127.0.0.1/llmhub",
    "postgresql://example:example@127.0.0.1/production_dev",
    "postgresql://example:example@127.0.0.1/postgres",
    "postgresql://example:example@127.0.0.1/llmhub%5fdev",
    "postgresql://example:example@127.0.0.1/llmhub_dev?host=remote",
    "postgresql://example:example@127.0.0.1/llmhub_dev?schema=production",
    "postgresql://example:example@127.0.0.1/llmhub_dev?options=-csearch_path%3Dproduction",
    "mysql://127.0.0.1/llmhub_dev",
    "invalid",
  ];
  let calls = 0;
  const run = async () => { calls += 1; };
  for (const DATABASE_URL of targets) {
    await assert.rejects(seedDevelopment({ env: { ...env, DATABASE_URL }, args, run }));
  }
  for (const NODE_ENV of [undefined, "test", "Production", "production "]) {
    const invalidEnv: NodeJS.ProcessEnv = { ...env };
    Reflect.set(invalidEnv, "NODE_ENV", NODE_ENV);
    await assert.rejects(seedDevelopment({ env: invalidEnv, args, run }));
  }
  for (const confirmation of [[], ["--force"], ["--reset-local=other_dev"], [...args, "--force"]]) {
    await assert.rejects(seedDevelopment({ env, args: confirmation, run }), /pass --reset-local/);
  }
  await assert.rejects(seedDevelopment({ env: { ...env, APP_SECRET: "" }, args, run }), /APP_SECRET/);
  assert.equal(calls, 0);
});

test("seed-dev allows explicit local development targets", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(validateSeedTarget({ ...env, DATABASE_URL: `postgresql://example:example@${host}:5433/llmhub_dev?schema=public` }, args), "llmhub_dev");
  }
});

test("seed-dev replays migration history, verifies it, then inserts fixtures with one frozen target", async () => {
  const calls: { command: string[]; target: string }[] = [];
  const source = { ...env };
  await seedDevelopment({ env: source, args, run: async (command: string[], childEnv: typeof env) => {
    calls.push({ command, target: childEnv.DATABASE_URL });
    source.DATABASE_URL = "postgresql://remote/production";
  } });
  assert.deepEqual(calls, [
    { command: ["node_modules/prisma/build/index.js", "migrate", "reset", "--force"], target: env.DATABASE_URL },
    { command: ["node_modules/prisma/build/index.js", "migrate", "status"], target: env.DATABASE_URL },
    { command: ["--conditions=react-server", "--import", "tsx", "scripts/seed-dev-data.mjs", ...args], target: env.DATABASE_URL },
  ]);
});

test("seed-dev stops on a failed reset or migration verification", async () => {
  for (const failingStep of [1, 2]) {
    let calls = 0;
    await assert.rejects(seedDevelopment({ env, args, run: async () => {
      calls += 1;
      if (calls === failingStep) throw new Error("migration failed");
    } }), /migration failed/);
    assert.equal(calls, failingStep);
  }
});

test("development fixtures contain only related product data and never operators or credentials", async () => {
  const rows = new Map<string, Record<string, unknown>[]>();
  const allowed = new Set(["organization", "team", "project", "member"]);
  const tx = new Proxy({}, { get: (_target, model: string) => {
    assert.ok(allowed.has(model), `unexpected fixture model ${model}`);
    return { create: async ({ data }: { data: Record<string, unknown> }) => {
      const list = rows.get(model) ?? [];
      const row = { ...data, id: `${model}-${list.length + 1}` };
      list.push(row);
      rows.set(model, list);
      return row;
    } };
  } });
  let transactions = 0;
  await insertDevelopmentFixtures({ $transaction: async (work: (client: object) => Promise<void>) => {
    transactions += 1;
    await work(tx);
  } });
  assert.equal(transactions, 1);
  assert.equal(rows.get("organization")?.length, 1);
  for (const model of ["team", "project", "member"]) {
    assert.equal(rows.get(model)?.length, 2);
    for (const row of rows.get(model) ?? []) assert.equal(row.orgId, "organization-1");
  }
  for (const model of ["project", "member"]) {
    assert.deepEqual(rows.get(model)?.map((row) => row.teamId), ["team-1", "team-2"]);
  }
  for (const records of rows.values()) {
    for (const row of records) {
      assert.equal(row.budgetDuration, "1mo");
      assert.ok(Number(row.maxBudget) > 0);
    }
  }
});

test("the fixture subprocess also refuses production before loading Prisma", () => {
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/seed-dev-data.mjs", ...args], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "invalid", APP_SECRET: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /production resets are forbidden/);
  assert.doesNotMatch(result.stderr, /Invalid environment|PrismaClient/);
});

test("the fixture subprocess loads the existing Prisma service with a database-free client", () => {
  const preload = `
    const allowed = new Set(["organization", "team", "project", "member"]);
    let writes = 0;
    const tx = new Proxy({}, { get: (_target, model) => {
      if (!allowed.has(model)) throw new Error("unexpected fixture model");
      return { create: async () => ({ id: model + (++writes) }) };
    } });
    globalThis.prisma = {
      $transaction: async (work) => work(tx),
      $disconnect: async () => {
        if (writes !== 7) throw new Error("missing product fixtures");
        console.log("fixtures-disconnected");
      },
    };
  `;
  const result = spawnSync(process.execPath, [
    "--conditions=react-server", "--import", "tsx",
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    "scripts/seed-dev-data.mjs", ...args,
  ], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixtures-disconnected/);
});
