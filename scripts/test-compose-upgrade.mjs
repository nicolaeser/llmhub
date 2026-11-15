import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const [image, expectedBuild] = process.argv.slice(2);
assert.ok(image && expectedBuild, "usage: node scripts/test-compose-upgrade.mjs <local-image> <expected-build-id>");
const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const project = `llmhub-compose-test-${randomBytes(6).toString("hex")}`;
const ownerKey = "llmhub.upgrade.validation";
const directory = await mkdtemp(path.join(tmpdir(), `${project}-`));
const composeFile = path.join(directory, "compose.json");
const registry = `${project}-registry`;
const oldTag = `${project}:old`;
const labels = { [ownerKey]: project };
const password = randomBytes(16).toString("hex");
const cli = path.join(root, "node_modules/prisma/build/index.js");
let reference;
let composeReady = false;
let client;

async function docker(...args) {
  return (await execute("docker", args, { cwd: root, timeout: 600_000, maxBuffer: 8 * 1024 ** 2 })).stdout.trim();
}

const compose = (...args) => docker("compose", "-p", project, "-f", composeFile, ...args);
const inspect = async (id) => JSON.parse(await docker("inspect", id))[0];

async function owned(service) {
  const id = await compose("ps", "--all", "-q", service);
  const info = await inspect(id);
  assert.equal(info.Config.Labels[ownerKey], project);
  return info;
}

async function eventually(check, description, timeout = 300_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try { if (await check()) return; } catch (error) { last = error; }
    await delay(1000);
  }
  throw new Error(`timed out: ${description}`, { cause: last });
}

try {
  const expected = JSON.parse(await docker("image", "inspect", image))[0];
  assert.equal(expected.Config.Env.find((value) => value.startsWith("BUILD_ID=")), `BUILD_ID=${expectedBuild}`);
  await docker("run", "-d", "--name", registry, "--label", `${ownerKey}=${project}`, "-p", "127.0.0.1::5000", "registry:3");
  const registryPort = (await inspect(registry)).NetworkSettings.Ports["5000/tcp"][0].HostPort;
  reference = `127.0.0.1:${registryPort}/llmhub:latest`;
  await eventually(async () => (await globalThis.fetch(`http://127.0.0.1:${registryPort}/v2/`)).ok, "local registry");
  await writeFile(path.join(directory, "Dockerfile"), `FROM node:24-alpine\nLABEL ${ownerKey}=${project}\nRUN mkdir /login-journal && chown node:node /login-journal && chmod 700 /login-journal\nVOLUME ["/login-journal"]\nUSER node\nCMD ["node", "-e", "setInterval(()=>{},1000)"]\n`);
  await docker("build", "-t", oldTag, directory);
  await docker("tag", oldTag, reference);
  await docker("push", reference);
  await writeFile(composeFile, JSON.stringify({ services: {
    postgres: { image: "postgres:18-alpine", labels, environment: { POSTGRES_USER: "upgrade", POSTGRES_PASSWORD: password, POSTGRES_DB: "upgrade" }, ports: ["127.0.0.1::5432"], volumes: ["postgres:/var/lib/postgresql"] },
    app: { image: reference, labels, ports: ["127.0.0.1::3000"], stop_grace_period: "45s", environment: {
      NODE_ENV: "production", APP_SECRET: randomBytes(32).toString("hex"), DATABASE_URL: `postgresql://upgrade:${password}@postgres:5432/upgrade`, NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    } },
    state: { image: reference, labels, user: "0:0", command: ["node", "-e", "setInterval(()=>{},1000)"] },
  }, volumes: { postgres: { labels } } }));
  composeReady = true;
  await compose("up", "-d", "postgres");
  const db = await owned("postgres");
  const url = `postgresql://upgrade:${password}@127.0.0.1:${db.NetworkSettings.Ports["5432/tcp"][0].HostPort}/upgrade`;
  await eventually(async () => (await docker("exec", db.Id, "pg_isready", "-h", "127.0.0.1", "-U", "upgrade")), "PostgreSQL");
  client = new pg.Client({ connectionString: url });
  await client.connect();
  console.log("PostgreSQL ready; preparing the historical database");
  const migrations = path.join(root, "prisma/migrations");
  const copied = path.join(directory, "migrations");
  await mkdir(copied);
  await cp(path.join(migrations, "migration_lock.toml"), path.join(copied, "migration_lock.toml"));
  const names = (await readdir(migrations, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name < "20261115145000_prisma_compatibility").map((entry) => entry.name);
  assert.equal(names.length, 63);
  for (const name of names) await cp(path.join(migrations, name), path.join(copied, name), { recursive: true });
  const config = path.join(directory, "prisma.config.ts");
  await writeFile(config, `import { defineConfig } from ${JSON.stringify(path.join(root, "node_modules/prisma/config.js"))};\nexport default defineConfig({schema:${JSON.stringify(path.join(root, "prisma/schema"))},migrations:{path:${JSON.stringify(copied)}},datasource:{url:process.env.DATABASE_URL}});\n`);
  const env = { ...process.env, NODE_ENV: "development", DATABASE_URL: url, APP_SECRET: "test-app-secret-aaaaaaaaaaaaaaaaaaaa" };
  const prisma = (args) => execute(process.execPath, [cli, ...args], { cwd: root, env, timeout: 180_000, maxBuffer: 8 * 1024 ** 2 });
  await prisma(["migrate", "deploy", "--config", config]);
  await client.query(`INSERT INTO "Setting" ("key", "value") VALUES ('upgrade-marker', '{"preserve":true}');
    INSERT INTO "RequestLog" ("id", "createdAt") VALUES ('upgrade-content', '2100-01-01');
    INSERT INTO "RequestLogContent" ("logId", "request", "response", "createdAt") VALUES ('upgrade-content', '{"text":"Grüße 🌍"}', NULL, '2100-01-01')`);
  const snapshot = async () => (await client.query(`SELECT
    (SELECT value FROM "Setting" WHERE key = 'upgrade-marker') AS setting,
    (SELECT request FROM "RequestLogContent" WHERE "logId" = 'upgrade-content') AS content`)).rows[0];
  const before = await snapshot();
  const blocker = new pg.Client({ connectionString: url });
  await blocker.connect();
  try {
    await blocker.query('BEGIN; LOCK TABLE "RequestLog" IN ACCESS EXCLUSIVE MODE');
    const migration = prisma(["migrate", "deploy"]).then(() => null, (error) => error);
    let pid;
    await eventually(async () => {
      pid = (await client.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE '%CREATE TABLE "RequestLogContent_plain"%'`)).rows[0]?.pid;
      return Boolean(pid);
    }, "migration lock", 90_000);
    await client.query("SELECT pg_terminate_backend($1)", [pid]);
    await blocker.query("ROLLBACK");
    assert.ok(await migration, "interruption must fail the migration");
  } finally { await blocker.end(); }
  assert.equal((await client.query('SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL')).rows[0].n, 1);
  console.log("Published compatibility migration interrupted and failure recorded");
  await compose("pull", "app");
  await compose("up", "-d", "app");
  const old = await owned("app");
  await docker("exec", old.Id, "node", "-e", "require('fs').writeFileSync('/login-journal/upgrade-sentinel','preserved')");
  const journal = old.Mounts.find((mount) => mount.Destination === "/login-journal").Name;
  await docker("tag", image, reference);
  await docker("push", reference);
  await docker("tag", oldTag, reference);
  assert.equal(JSON.parse(await docker("image", "inspect", reference))[0].Id, old.Image);
  await compose("pull", "app", "state");
  assert.equal(JSON.parse(await docker("image", "inspect", reference))[0].Id, expected.Id);
  console.log("Compose pull selected the new registry image over the old local tag");
  assert.equal((await owned("app")).Id, old.Id, "pull must only download");
  await compose("up", "-d", "app", "state");
  const updated = await owned("app");
  assert.notEqual(updated.Id, old.Id);
  assert.equal(updated.Image, expected.Id);
  assert.equal(updated.Mounts.find((mount) => mount.Destination === "/login-journal").Name, journal);
  const origin = `http://127.0.0.1:${updated.NetworkSettings.Ports["3000/tcp"][0].HostPort}`;
  await eventually(async () => (await globalThis.fetch(`${origin}/internal-api/ready`, { signal: globalThis.AbortSignal.timeout(5000) })).ok, "upgraded app readiness");
  const version = await (await globalThis.fetch(`${origin}/internal-api/version`)).json();
  assert.equal(version.version, expectedBuild);
  console.log("Upgraded app ready on the expected build");
  assert.deepEqual(await snapshot(), before);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL')).rows[0].n, 0);
  assert.equal((await client.query(`SELECT relkind FROM pg_class WHERE oid = '"RequestLogContent"'::regclass`)).rows[0].relkind, "r");
  assert.equal(await docker("exec", updated.Id, "node", "-e", "process.stdout.write(require('fs').readFileSync('/login-journal/upgrade-sentinel','utf8'))"), "preserved");
  await eventually(async () => /"event":"keeper.started".*"journal":true/.test(await docker("logs", updated.Id)), "embedded keeper");
  const state = await owned("state");
  await docker("exec", state.Id, "node", "-e", "require('fs').writeFileSync('/root/.llmhub-updater/transaction.json','preserved')");
  const stateVolume = state.Mounts.find((mount) => mount.Destination === "/root/.llmhub-updater").Name;
  await compose("up", "-d", "--force-recreate", "state");
  const recreated = await owned("state");
  assert.equal(recreated.Mounts.find((mount) => mount.Destination === "/root/.llmhub-updater").Name, stateVolume);
  assert.equal(await docker("exec", recreated.Id, "node", "-e", "process.stdout.write(require('fs').readFileSync('/root/.llmhub-updater/transaction.json','utf8'))"), "preserved");
  console.log("PASS: Compose pull/up, interrupted migration recovery, preserved content and anonymous volumes, embedded keeper, updater journal recreation");
} catch (error) {
  if (composeReady) console.error(await compose("logs", "--tail", "100", "app").catch(() => "App logs unavailable"));
  throw error;
} finally {
  await client?.end().catch(() => {});
  if (composeReady) await compose("down", "--volumes", "--remove-orphans", "--timeout", "45").catch((error) => console.error(error.message));
  const registryInfo = await inspect(registry).catch(() => null);
  if (registryInfo?.Config.Labels[ownerKey] === project) await docker("rm", "-f", "-v", registry);
  for (const tag of [reference, oldTag].filter(Boolean)) await docker("image", "rm", tag).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
