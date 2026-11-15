import { spawn } from "node:child_process";

export function validateMigrationEnv(env) {
  if (!["development", "production"].includes(env.NODE_ENV?.trim())) {
    throw new Error("NODE_ENV must be development or production");
  }
  if (!env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  if ((env.APP_SECRET?.trim().length ?? 0) < 32) throw new Error("APP_SECRET must be at least 32 characters");
}

export function runPrisma(args, env, onOutput, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./node_modules/prisma/build/index.js", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let output = "";
    let failure;
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-65_536);
        onOutput(chunk);
      });
    }
    child.once("error", (error) => { failure = error; });
    child.once("close", (code, signal) => {
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, signal, output });
    });
  });
}
