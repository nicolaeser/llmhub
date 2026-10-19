import { stat } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { createAgent, HEARTBEAT_FILE, HEARTBEAT_MAX_AGE_MS, PREDECESSOR_ENV } from "./updater/agent.mjs";
import { dockerClient } from "./updater/docker.mjs";
import { errorMessage, log } from "./updater/log.mjs";
import { updaterKey } from "./updater/signature.mjs";

const DEFAULT_APP_URL = "http://app:3000";

async function healthcheck() {
  try {
    const info = await stat(HEARTBEAT_FILE);
    return Date.now() - info.mtimeMs < HEARTBEAT_MAX_AGE_MS ? 0 : 1;
  } catch {
    return 1;
  }
}

function settings() {
  const secret = process.env.APP_SECRET ?? "";
  if (secret.length < 32) throw new Error("APP_SECRET must be at least 32 characters");
  const appUrl = new URL(process.env.LLMHUB_UPDATER_APP_URL?.trim() || DEFAULT_APP_URL);
  if (appUrl.protocol !== "http:" && appUrl.protocol !== "https:") {
    throw new Error("LLMHUB_UPDATER_APP_URL must be an http or https URL");
  }
  return {
    key: updaterKey(secret),
    appUrl,
    projectOverride: process.env.LLMHUB_UPDATER_PROJECT?.trim() || null,
    predecessor: process.env[PREDECESSOR_ENV]?.trim() || null,
    version: process.env.BUILD_ID?.trim() || "development",
  };
}

async function main() {
  if (process.argv.includes("--healthcheck")) {
    process.exitCode = await healthcheck();
    return;
  }
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      log("info", "updater.stopping", { signal });
      process.exit(0);
    });
  }
  await createAgent({ docker: dockerClient(), ...settings() }).start();
}

main().catch((err) => {
  log("error", "updater.crashed", { err: errorMessage(err) });
  process.exit(1);
});
