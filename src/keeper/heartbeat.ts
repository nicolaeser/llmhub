import { stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const KEEPER_CYCLE_MS = 60_000;
export const KEEPER_STALE_MS = 3 * KEEPER_CYCLE_MS;
export const KEEPER_STUCK_MS = 10 * KEEPER_CYCLE_MS;
export const KEEPER_HEARTBEAT_FILE = path.join(tmpdir(), "llmhub-keeper-heartbeat");

export async function writeHeartbeat(file = KEEPER_HEARTBEAT_FILE, now = new Date()): Promise<void> {
  await writeFile(file, now.toISOString(), "utf8");
}

export async function heartbeatFresh(file = KEEPER_HEARTBEAT_FILE, now = Date.now()): Promise<boolean> {
  try {
    return now - (await stat(file)).mtimeMs < KEEPER_STALE_MS;
  } catch {
    return false;
  }
}
