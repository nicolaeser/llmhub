import { clearTimeout, setTimeout } from "node:timers";

export const STARTUP_STATUS_PATH = "/home/node/.llmhub-startup/status.json";
export const MIGRATION_WAIT_MS = 30 * 60_000;
export const STARTUP_STALE_MS = 90_000;
export const STARTUP_READ_MS = 5_000;
export const STARTUP_RECOVERY_HELP = "Preserve the replacement container and old-container backups. Do not stop an active migration or roll back the database automatically. Inspect app migration logs and Prisma migration status; back up the database and follow the README migration recovery procedure before resuming updates.";

const pendingReads = new WeakMap();

export async function inspectStartup(docker, id, info, { now = Date.now(), readTimeoutMs = STARTUP_READ_MS } = {}) {
  const manual = (reason, metadata = {}) => ({ ...metadata, decision: "manual_recovery", state: "manual_recovery", manualRecovery: true, rollbackSafe: false, reason, help: STARTUP_RECOVERY_HELP });
  let reads = pendingReads.get(docker);
  if (!reads) pendingReads.set(docker, reads = new Map());
  let timer;
  let raw;
  try {
    let read = reads.get(id);
    if (!read) {
      read = Promise.resolve().then(() => docker.readFile(id, STARTUP_STATUS_PATH));
      reads.set(id, read);
      void read.finally(() => reads.delete(id)).catch(() => {});
    }
    raw = await Promise.race([read, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("startup status read timed out")), readTimeoutMs);
    })]);
  } catch (error) {
    if (error.status === 404) return { decision: "legacy", state: null };
    return manual("Startup status is unreadable");
  } finally {
    clearTimeout(timer);
  }
  let status;
  try {
    if (typeof raw !== "string" || raw.length > 16_384) return manual("Invalid startup status");
    status = JSON.parse(raw);
  } catch {
    return manual("Invalid startup status");
  }
  if (!status || status.version !== 1 || !["migrating", "migration_failed", "starting"].includes(status.state)
    || typeof status.bootId !== "string" || ![true, false, "unknown"].includes(status.schemaChanged)) return manual("Invalid startup status");
  const boot = Date.parse(status.bootStartedAt);
  const beat = Date.parse(status.heartbeatAt);
  const migration = Date.parse(status.migrationStartedAt);
  const containerStart = Date.parse(info?.State?.StartedAt);
  const metadata = { ...status, rollbackSafe: status.schemaChanged === false };
  if (![boot, beat, migration, containerStart].every(Number.isFinite)
    || boot < containerStart || beat < boot || migration < boot || beat > now + 5_000
    || !info?.State?.Running) return manual("Startup status belongs to an inactive or previous container start", metadata);
  if (now - beat > STARTUP_STALE_MS) return manual("Startup heartbeat is stale", metadata);
  if (status.state === "migration_failed") return { ...manual("Database migration failed", metadata), state: "migration_failed" };
  if (status.state === "migrating") {
    if (now - migration >= MIGRATION_WAIT_MS) return manual("Migration wait budget exhausted; migration has not been stopped", metadata);
    return { ...metadata, decision: "wait", rollbackSafe: false };
  }
  return { ...metadata, decision: "health" };
}
