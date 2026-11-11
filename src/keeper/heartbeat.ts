import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const KEEPER_CYCLE_MS = 60_000;
export const KEEPER_STALE_MS = 3 * KEEPER_CYCLE_MS;
export const KEEPER_STUCK_MS = 10 * KEEPER_CYCLE_MS;
export const KEEPER_STATE_DIR = path.join(homedir(), ".llmhub-keeper");
export const KEEPER_HEARTBEAT_FILE = path.join(KEEPER_STATE_DIR, "heartbeat");

export async function writeHeartbeat(file = KEEPER_HEARTBEAT_FILE, now = new Date()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, now.toISOString(), { encoding: "utf8", mode: 0o600 });
}

export async function heartbeatFresh(file = KEEPER_HEARTBEAT_FILE, now = Date.now()): Promise<boolean> {
  try {
    return now - (await stat(file)).mtimeMs < KEEPER_STALE_MS;
  } catch {
    return false;
  }
}
