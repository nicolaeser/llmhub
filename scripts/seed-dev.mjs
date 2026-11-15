import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export function assertDevelopment(env) {
  if (env.NODE_ENV !== "development") {
    throw new Error("seed-dev requires NODE_ENV=development; production resets are forbidden");
  }
}

export function validateSeedTarget(env, args) {
  assertDevelopment(env);
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("seed-dev requires a local PostgreSQL DATABASE_URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("seed-dev only resets loopback PostgreSQL targets");
  }
  const database = url.pathname.slice(1);
  if (!/^[a-z][a-z0-9_]*_(dev|development)$/.test(database) || /(^|_)(prod|production)(_|$)/.test(database)) {
    throw new Error("seed-dev requires a dedicated database ending in _dev or _development");
  }
  if (url.hash || [...url.searchParams].some(([key, value]) => key !== "schema" || value !== "public")) {
    throw new Error("seed-dev forbids connection overrides and non-public schemas");
  }
  if (args.length !== 1 || args[0] !== `--reset-local=${database}`) {
    throw new Error("seed-dev deletes all target data; pass --reset-local=<database-name> to confirm");
  }
  if ((env.APP_SECRET?.trim().length ?? 0) < 32) {
    throw new Error("APP_SECRET must be at least 32 characters before seed-dev can reset");
  }
  return database;
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`seed-dev step failed (${signal ?? `exit ${code}`})`));
    });
  });
}

export async function seedDevelopment({ env = process.env, args = process.argv.slice(2), run = runNode } = {}) {
  validateSeedTarget(env, args);
  const childEnv = { ...env };
  await run(["node_modules/prisma/build/index.js", "migrate", "reset", "--force"], childEnv);
  await run(["node_modules/prisma/build/index.js", "migrate", "status"], childEnv);
  await run(["--conditions=react-server", "--import", "tsx", "scripts/seed-dev-data.mjs", ...args], childEnv);
}

async function main() {
  try {
    if (process.env.NODE_ENV !== undefined) assertDevelopment(process.env);
    const { config } = await import("dotenv");
    config({ path: path.join(root, ".env"), quiet: true });
    await seedDevelopment();
    console.log("[seed-dev] Mock product data inserted; no operators or credentials created");
  } catch (error) {
    console.error(`[seed-dev] ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
