import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const { values: args } = parseArgs({
  options: {
    build: { type: "string", default: join(root, ".next/standalone") },
    mounts: { type: "string", default: "subscription,api" },
    stages: { type: "string", default: "50:60,100:60,200:60" },
    accounts: { type: "string", default: "4" },
    "api-keys": { type: "string", default: "2" },
    members: { type: "string", default: "20" },
    "abort-rate": { type: "string", default: "0.04" },
    "count-tokens": { type: "string", default: "0.08" },
    "error-429": { type: "string", default: "0.005" },
    "error-529": { type: "string", default: "0.005" },
    "stream-error": { type: "string", default: "0.003" },
    disconnect: { type: "string", default: "0.003" },
    "retry-after": { type: "string", default: "2" },
    "long-rate": { type: "string", default: "0.03" },
    "ttfb-ms": { type: "string", default: "400" },
    "tokens-per-sec": { type: "string", default: "120" },
    "no-redis": { type: "boolean", default: false },
    out: { type: "string", default: "" },
    label: { type: "string", default: "loadtest" },
  },
});

const id = `llmhub-loadtest-${randomBytes(4).toString("hex")}`;
const outDir = args.out ? resolve(args.out) : mkdtempSync(join(tmpdir(), "llmhub-loadtest-"));
mkdirSync(outDir, { recursive: true });
const secret = randomBytes(32).toString("hex");
const pgPassword = randomBytes(16).toString("hex");
const redisPassword = randomBytes(16).toString("hex");
const containers = [];
const children = new Set();
const useRedis = !args["no-redis"];
const build = resolve(args.build);

function baseEnv() {
  const copy = { ...process.env };
  for (const name of ["DATABASE_URL", "REDIS_URL", "APP_SECRET", "NEXT_PUBLIC_APP_URL", "NODE_OPTIONS", "PORT", "HOSTNAME"]) delete copy[name];
  return copy;
}

function log(message) {
  console.log(`[loadtest] ${message}`);
}

async function docker(...argv) {
  const { stdout } = await run("docker", argv, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function hostPort(name, port) {
  const mapped = await docker("port", name, `${port}/tcp`);
  const line = mapped.split("\n").find((entry) => entry.startsWith("127.0.0.1:")) ?? "";
  return Number(line.split(":")[1]);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function until(label, check, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`${label} did not become ready within ${seconds} s`);
}

function start(name, command, argv, options) {
  const output = createWriteStream(join(outDir, `${name}.log`));
  const child = spawn(command, argv, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function finished(child) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit(child.exitCode);
    else child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([finished(child), sleep(15_000).then(() => null)]);
  if (exited === null) child.kill("SIGKILL");
}

async function startDatabase() {
  const name = `${id}-pg`;
  await docker(
    "run", "-d", "--name", name, "--memory", "2g",
    "-e", "POSTGRES_USER=llmhub", "-e", `POSTGRES_PASSWORD=${pgPassword}`, "-e", "POSTGRES_DB=llmhub",
    "-p", "127.0.0.1::5432", "postgres:18-alpine",
    "-c", "shared_preload_libraries=pg_stat_statements", "-c", "max_connections=200",
  );
  containers.push(name);
  await until("Postgres", () => docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "llmhub", "-d", "llmhub").then(() => true), 90);
  const port = await hostPort(name, 5432);
  return { name, url: `postgresql://llmhub:${pgPassword}@127.0.0.1:${port}/llmhub` };
}

async function startRedis() {
  const name = `${id}-redis`;
  await docker("run", "-d", "--name", name, "--memory", "512m", "-p", "127.0.0.1::6379", "redis:8-alpine", "redis-server", "--requirepass", redisPassword, "--save", "");
  containers.push(name);
  await until("Redis", () => docker("exec", "-e", `REDISCLI_AUTH=${redisPassword}`, name, "redis-cli", "ping").then((out) => out === "PONG"), 60);
  const port = await hostPort(name, 6379);
  return `redis://:${redisPassword}@127.0.0.1:${port}`;
}

async function startMock() {
  const child = start("mock", process.execPath, [
    join(here, "mock-upstream.mjs"),
    "--ttfb-ms", args["ttfb-ms"], "--tokens-per-sec", args["tokens-per-sec"],
    "--error-429", args["error-429"], "--error-529", args["error-529"],
    "--stream-error", args["stream-error"], "--disconnect", args.disconnect,
    "--retry-after", args["retry-after"], "--long-rate", args["long-rate"],
  ], { cwd: root });
  const url = await new Promise((resolveUrl, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n")[0];
      if (buffer.includes("\n")) resolveUrl(JSON.parse(line).mock);
    });
    child.once("exit", (code) => reject(new Error(`mock upstream exited with ${code}`)));
  });
  return { child, url };
}

async function migrate(databaseUrl) {
  await run("npx", ["prisma", "migrate", "deploy"], { cwd: root, env: { ...baseEnv(), DATABASE_URL: databaseUrl }, maxBuffer: 16 * 1024 * 1024 });
}

async function seed(databaseUrl, mockUrl) {
  const state = join(outDir, "state.json");
  const child = start("seed", process.execPath, [
    "--import", "tsx", "--import", "./src/tests/register-server-only.mjs", "--import", "./src/tests/integration/support/register.mjs",
    "--import", "./scripts/loadtest/server-preload.mjs",
    "scripts/loadtest/seed.ts", "--mock", mockUrl, "--out", state,
    "--accounts", args.accounts, "--api-keys", args["api-keys"], "--members", args.members,
  ], { cwd: root, env: { ...baseEnv(), NODE_ENV: "development", DATABASE_URL: databaseUrl, APP_SECRET: secret, LOADTEST_MOCK_URL: mockUrl } });
  if ((await finished(child)) !== 0) throw new Error(`seeding failed, see ${join(outDir, "seed.log")}`);
  return state;
}

async function startServer(databaseUrl, redisUrl, mockUrl) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const metrics = join(outDir, "metrics.jsonl");
  const child = start("server", process.execPath, ["server.js"], {
    cwd: build,
    env: {
      ...baseEnv(),
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      IP_MODE: "direct",
      DATABASE_URL: databaseUrl,
      ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
      APP_SECRET: secret,
      NEXT_PUBLIC_APP_URL: base,
      LOADTEST_MOCK_URL: mockUrl,
      LOADTEST_METRICS_FILE: metrics,
      NODE_OPTIONS: `--import ${pathToFileURL(join(here, "server-preload.mjs")).href}`,
    },
  });
  await until("the app", async () => (await globalThis.fetch(`${base}/internal-api/ready`)).ok, 120);
  return { child, base, metrics };
}

async function load(mount, context) {
  const out = join(outDir, `${args.label}-${mount}.json`);
  const child = spawn(process.execPath, [
    join(here, "load.mjs"),
    "--state", context.state, "--base", context.base, "--mount", mount, "--stages", args.stages,
    "--mock", context.mockUrl, "--metrics", context.metrics, "--pg-container", context.pg,
    "--abort-rate", args["abort-rate"], "--count-tokens", args["count-tokens"],
    "--label", `${args.label}-${mount}`, "--out", out,
  ], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  children.add(child);
  const code = await finished(child);
  children.delete(child);
  if (code !== 0) throw new Error(`load run for ${mount} exited with ${code}`);
  return out;
}

async function cleanup() {
  await Promise.all([...children].map((child) => stop(child)));
  for (const name of containers.splice(0)) await docker("rm", "-f", "-v", name).catch(() => "");
}

async function main() {
  if (!existsSync(join(build, "server.js"))) throw new Error(`no standalone build at ${build}; run npm run build first`);
  const mounts = args.mounts.split(",").map((mount) => mount.trim()).filter(Boolean);
  for (const mount of mounts) if (mount !== "subscription" && mount !== "api") throw new Error(`unknown mount ${mount}`);
  log(`results in ${outDir}`);
  const [database, redisUrl, mock] = await Promise.all([startDatabase(), useRedis ? startRedis() : Promise.resolve(""), startMock()]);
  log(`mock upstream on ${mock.url}`);
  await migrate(database.url);
  await docker("exec", database.name, "psql", "-U", "llmhub", "-d", "llmhub", "-qc", "create extension if not exists pg_stat_statements");
  const state = await seed(database.url, mock.url);
  const server = await startServer(database.url, redisUrl, mock.url);
  log(`app on ${server.base} (${useRedis ? "Redis" : "no Redis"})`);
  const reports = [];
  for (const mount of mounts) {
    log(`${mount}: stages ${args.stages}`);
    reports.push(await load(mount, { state, base: server.base, mockUrl: mock.url, metrics: server.metrics, pg: database.name }));
  }
  log(`reports: ${reports.join(", ")}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });
}

process.once("uncaughtException", (err) => {
  console.error(`[loadtest] ${err instanceof Error ? err.message : String(err)}`);
  void cleanup().finally(() => process.exit(1));
});

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`[loadtest] ${err instanceof Error ? err.message : String(err)}`);
    await cleanup();
    process.exit(1);
  });
