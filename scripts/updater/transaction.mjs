import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { COMPOSE_PROJECT_LABEL, UPDATER_IMAGE_REF_LABEL, composeImageLabel, containerName, createConfigFor, stopSeconds } from "./container-config.mjs";
import { errorMessage, log } from "./log.mjs";
import { UPDATE_DRAIN_SECONDS, waitHealthy, waitStopped } from "./recreate.mjs";

export const DEFAULT_JOURNAL_FILE = join(homedir(), ".llmhub-updater", "transaction.json");
const TARGET = "llmhub.updater.target";
const TRANSACTION = "llmhub.updater.transaction";
const ORIGINAL = "llmhub.updater.original";
const SERVICE = "com.docker.compose.service";

async function syncDirectory(file) {
  const handle = await open(dirname(file), "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function save(file, plan) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(plan));
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, file);
  await syncDirectory(file);
}

async function read(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

async function clear(file) {
  await unlink(file);
  await syncDirectory(file);
}

function manual(message, startup) {
  return Object.assign(new Error(message), { manualRecovery: true, startup });
}

function validate(plan, project) {
  if (!plan || plan.version !== 1 || plan.project !== project || !/^[a-f0-9-]{36}$/.test(plan.id) ||
      !["active", "rollback", "committed", "manual_recovery"].includes(plan.state) || !Array.isArray(plan.entries) || !plan.entries.length) {
    throw manual("invalid updater transaction journal; manual recovery required");
  }
  const ids = new Set();
  const names = new Set();
  for (const entry of plan.entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry.name) || typeof entry.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(entry.id) ||
        entry.backup !== `${entry.name}-llmhub-tx-${plan.id}` || typeof entry.running !== "boolean" || typeof entry.touched !== "boolean" ||
        typeof entry.service !== "string" || !entry.service || typeof entry.image !== "string" || ids.has(entry.id) || names.has(entry.name)) {
      throw manual("invalid updater transaction target; manual recovery required");
    }
    ids.add(entry.id);
    names.add(entry.name);
  }
}

function scoped(info, plan, entry) {
  const labels = info?.Config?.Labels;
  return labels?.[COMPOSE_PROJECT_LABEL] === plan.project && labels?.[TARGET] === "true" && labels?.[SERVICE] === entry.service;
}

async function inspectEntry(docker, plan, entry) {
  const old = await docker.inspectContainer(entry.id);
  if (old && (!scoped(old, plan, entry) || old.Id !== entry.id || old.Image !== entry.image || ![entry.name, entry.backup].includes(containerName(old)))) {
    throw manual(`original container identity changed for ${entry.name}`);
  }
  const named = await docker.inspectContainer(entry.name);
  const replacement = named?.Id === entry.id ? null : named;
  if (replacement && (!scoped(replacement, plan, entry) || replacement.Config.Labels[TRANSACTION] !== plan.id || replacement.Config.Labels[ORIGINAL] !== entry.id)) {
    throw manual(`unrelated container occupies ${entry.name}`);
  }
  const backup = await docker.inspectContainer(entry.backup);
  if (backup && backup.Id !== entry.id) throw manual(`unrelated container occupies ${entry.backup}`);
  return { old, replacement };
}

async function report(onPhase, state, entry, completed, total) {
  try { await onPhase?.(state, { service: entry?.service, completed, total }); }
  catch (err) { log("warn", "updater.phase_report_failed", { err: errorMessage(err) }); }
}

async function cleanup(docker, plan, file) {
  for (const entry of plan.entries) {
    const { old, replacement } = await inspectEntry(docker, plan, entry);
    if (!replacement) throw manual(`committed replacement missing for ${entry.name}`);
    if (old) await docker.remove(old.Id);
  }
  await clear(file);
}

async function rollback(docker, plan, options) {
  const { journalFile, waitOptions, onPhase } = options;
  const inspected = [];
  for (const entry of plan.entries) {
    const found = await inspectEntry(docker, plan, entry);
    if (!found.old) throw manual(`original container missing for ${entry.name}`);
    if (!found.replacement && entry.rollbackSafe === false) throw manual(`migration replacement missing for ${entry.name}`, entry.startup);
    inspected.push({ entry, ...found });
  }
  for (const { entry, replacement } of inspected) {
    if (!replacement || !entry.running) continue;
    try {
      await waitHealthy(docker, replacement.Id, { ...waitOptions, onStartup: async (startup) => {
        await waitOptions?.onStartup?.(startup);
        if ((startup.decision === "health" && startup.rollbackSafe === false) || (startup.decision === "legacy" && entry.rollbackSafe === false)) {
          throw manual("database schema changed; container rollback requires manual recovery", startup);
        }
      } });
    }
    catch (err) { if (err.manualRecovery) throw err; }
  }
  if (plan.state !== "rollback") {
    for (const { entry, old } of inspected) {
      if (entry.touched && entry.running) {
        if (old.State?.Running) await docker.stop(old.Id, Math.min(stopSeconds(old), UPDATE_DRAIN_SECONDS));
        await waitStopped(docker, old.Id, waitOptions);
      }
    }
  }
  plan.state = "rollback";
  await save(journalFile, plan);
  let completed = 0;
  for (const { entry } of inspected.reverse()) {
    if (!entry.touched) continue;
    const { old, replacement } = await inspectEntry(docker, plan, entry);
    if (!old) throw manual(`original container missing for ${entry.name}`);
    if (replacement) await docker.remove(replacement.Id);
    if (entry.running && !old.State?.Running) {
      await waitStopped(docker, old.Id, waitOptions);
      for (let attempt = 0; ; attempt += 1) {
        try { await docker.start(old.Id); break; }
        catch (err) { if (attempt >= 2) throw err; await sleep(1000); }
      }
    }
    if (containerName(old) !== entry.name) await docker.rename(old.Id, entry.name);
    completed += 1;
    await report(onPhase, "rolling_back", entry, completed, plan.entries.length);
  }
  await clear(journalFile);
}

export async function recoverGroup(docker, projectLabel, { journalFile = DEFAULT_JOURNAL_FILE, onPhase, waitOptions } = {}) {
  const plan = await read(journalFile);
  if (!plan) return { recovered: false };
  const prefix = `${COMPOSE_PROJECT_LABEL}=`;
  if (!projectLabel?.startsWith(prefix) || !projectLabel.slice(prefix.length)) throw manual("invalid compose project scope");
  validate(plan, projectLabel.slice(prefix.length));
  if (plan.state === "manual_recovery") throw manual("updater transaction requires manual recovery", plan.startup);
  try {
    if (plan.state === "committed") await cleanup(docker, plan, journalFile);
    else await rollback(docker, plan, { journalFile, onPhase, waitOptions });
  } catch (err) {
    if (err.manualRecovery && plan.state !== "committed") {
      plan.state = "manual_recovery";
      plan.startup = err.startup;
      await save(journalFile, plan);
    }
    throw err;
  }
  return { recovered: true, committed: plan.state === "committed" };
}

export async function recreateGroup(docker, containers, { imageRef, image, onPhase = (state, progress) => { void state; void progress; }, waitOptions, journalFile = DEFAULT_JOURNAL_FILE }) {
  if (!containers.length) return [];
  if (await read(journalFile)) throw manual("unresolved updater transaction must be recovered first");
  const project = containers[0].Config?.Labels?.[COMPOSE_PROJECT_LABEL];
  if (!project) throw manual("targets require a compose project");
  const plan = { version: 1, id: randomUUID(), project, state: "active", entries: [] };
  const bodies = new Map();
  for (const supplied of containers) {
    const container = await docker.inspectContainer(supplied.Id);
    if (!container || container.Id !== supplied.Id) throw new Error("update target disappeared");
    const name = containerName(container);
    const entry = { id: container.Id, name, backup: `${name}-llmhub-tx-${plan.id}`, running: container.State?.Running === true,
      touched: false, image: container.Image, service: container.Config?.Labels?.[SERVICE] };
    if (!scoped(container, plan, entry) || /-llmhub-(old|stopped-old|tx-)/.test(name)) throw manual(`invalid update target ${name}`);
    if (await docker.inspectContainer(entry.backup)) throw manual(`unresolved backup for ${name}`);
    const oldImage = await docker.inspectImage(container.Image);
    if (!oldImage) throw new Error(`the image of ${name} cannot be inspected`);
    const body = createConfigFor(container, oldImage, { imageRef, imageId: image.Id,
      composeImage: composeImageLabel(container, image), stopTimeout: stopSeconds(container) });
    body.Image = image.Id;
    body.Labels = { ...body.Labels, [COMPOSE_PROJECT_LABEL]: project, [TARGET]: "true", [SERVICE]: entry.service, [TRANSACTION]: plan.id, [ORIGINAL]: entry.id, [UPDATER_IMAGE_REF_LABEL]: imageRef };
    bodies.set(entry.id, body);
    plan.entries.push(entry);
  }
  validate(plan, project);
  await save(journalFile, plan);
  const results = [];
  try {
    for (const entry of plan.entries) {
      const { old, replacement } = await inspectEntry(docker, plan, entry);
      if (!old || replacement || containerName(old) !== entry.name) throw manual(`update target changed for ${entry.name}`);
      entry.touched = true;
      await save(journalFile, plan);
      await report(onPhase, "recreating", entry, results.length, plan.entries.length);
      if (entry.running) {
        await docker.stop(entry.id, Math.min(stopSeconds(old), UPDATE_DRAIN_SECONDS));
        await waitStopped(docker, entry.id, waitOptions);
      }
      await docker.rename(entry.id, entry.backup);
      const created = await docker.create(entry.name, bodies.get(entry.id));
      if (entry.running) {
        await docker.start(created.Id);
        await report(onPhase, "verifying", entry, results.length, plan.entries.length);
        await waitHealthy(docker, created.Id, { ...waitOptions, onStartup: async (startup) => {
          if (startup.rollbackSafe !== undefined && entry.rollbackSafe !== startup.rollbackSafe) {
            entry.rollbackSafe = startup.rollbackSafe;
            entry.startup = startup;
            await save(journalFile, plan);
          }
          await waitOptions?.onStartup?.(startup);
        } });
      }
      results.push({ id: created.Id, name: entry.name, oldImageId: entry.image });
    }
  } catch (err) {
    if (err.manualRecovery) {
      plan.state = "manual_recovery";
      plan.startup = err.startup;
      await save(journalFile, plan);
      throw err;
    }
    try { await rollback(docker, plan, { journalFile, waitOptions, onPhase }); }
    catch (rollbackError) {
      if (rollbackError.manualRecovery) {
        plan.state = "manual_recovery";
        plan.startup = rollbackError.startup;
        await save(journalFile, plan);
        throw rollbackError;
      }
      throw Object.assign(new Error(`${err.message}; rollback incomplete: ${rollbackError.message}`), { rolledBack: false });
    }
    throw Object.assign(err, { rolledBack: true });
  }
  plan.state = "committed";
  await save(journalFile, plan);
  try { await cleanup(docker, plan, journalFile); }
  catch (err) { throw Object.assign(err, { committed: true }); }
  return results;
}
