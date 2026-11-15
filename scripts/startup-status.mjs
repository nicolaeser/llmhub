import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { STARTUP_STATUS_PATH } from "./updater/startup.mjs";

export function createStartupStatus(file = STARTUP_STATUS_PATH) {
  let previous;
  try {
    previous = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") previous = { schemaChanged: "unknown" };
  }
  const started = new Date().toISOString();
  let inherited = previous && (previous.state !== "starting" || previous.schemaChanged !== false)
    ? previous.schemaChanged === true ? true : "unknown" : false;
  let status = { version: 1, bootId: randomUUID(), bootStartedAt: started, migrationStartedAt: started,
    heartbeatAt: started, state: "migrating", schemaChanged: inherited === true ? true : "unknown" };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const persist = () => {
    const temporary = `${file}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(status));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, file);
    const directory = openSync(path.dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  persist();
  return {
    update(patch = {}) {
      if (patch.schemaChanged === true) inherited = true;
      if (patch.state === "migration_failed") inherited = inherited === true ? true : "unknown";
      status = { ...status, ...patch, heartbeatAt: new Date().toISOString() };
      if (inherited !== false) status.schemaChanged = inherited;
      persist();
      return status;
    },
  };
}
