import { spawn } from "node:child_process";
import pg from "pg";

const { Pool } = pg;
const DATABASE_CONNECT_ATTEMPTS = 30;
const DATABASE_CONNECT_DELAY_MS = 2_000;
const LOCK_KEY = 4_211_337;

function runPrisma(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["./node_modules/prisma/build/index.js", ...args],
      { stdio: "inherit", env: process.env },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(code);
        return;
      }
      reject(new Error(`prisma ${args.join(" ")} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

async function waitForDatabase(pool) {
  for (let attempt = 1; attempt <= DATABASE_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === DATABASE_CONNECT_ATTEMPTS) {
        throw new Error("database did not become ready before migration", { cause: error });
      }
      console.log(`[migrate] waiting for database (${attempt}/${DATABASE_CONNECT_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, DATABASE_CONNECT_DELAY_MS));
    }
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateStartupEnv() {
  required("DATABASE_URL");
  if (required("APP_SECRET").length < 32) {
    throw new Error("APP_SECRET must be at least 32 characters");
  }
}

async function main() {
  validateStartupEnv();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let client;
  try {
    await waitForDatabase(pool);
    client = await pool.connect();
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      await runPrisma(["migrate", "deploy"]);
      await runPrisma(["migrate", "status"]);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[migrate] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
