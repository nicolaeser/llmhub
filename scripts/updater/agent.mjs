import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, open, readFile, rename, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { COMPOSE_PROJECT_LABEL, composeImageLabel, configuredImageRef, containerName, createConfigFor, shortId } from "./container-config.mjs";
import { DockerError } from "./docker.mjs";
import { parseJson, readText, send } from "./http.mjs";
import { digestsFor, imageRefOf, isPinned, normalizeRepository, parseImageRef, updateAvailable } from "./image-ref.mjs";
import { errorMessage, log, PREDECESSOR_LOG_LINES, replayLogText } from "./log.mjs";
import { isBackup, recoverLeftovers, removeContainerNamed } from "./recreate.mjs";
import { recreateGroup, recoverGroup } from "./transaction.mjs";
import { signBody, UPDATER_HEADER, verifySignature } from "./signature.mjs";
import { switchRedisToSnapshots } from "./stack.mjs";

export const TARGET_LABEL = "llmhub.updater.target";
export const PREDECESSOR_ENV = "LLMHUB_UPDATER_PREDECESSOR";
export const SYNC_INTERVAL_MS = 10_000;
export const CHECK_INTERVAL_MS = 5 * 60_000;
export const AUTO_TRUST_MS = 5 * 60_000;
export const HANDOVER_TIMEOUT_MS = 2 * 60_000;
export const STATE_DIR = path.join(os.homedir(), ".llmhub-updater");
export const HEARTBEAT_FILE = path.join(STATE_DIR, "heartbeat");
export const HEARTBEAT_MAX_AGE_MS = 90_000;
export const MIN_FREE_DISK_BYTES = 2 * 1024 ** 3;
export const MIN_SWITCH_DISK_BYTES = 512 * 1024 ** 2;

const STATE_FILE = path.join(STATE_DIR, "state.json");
const SYNC_TIMEOUT_MS = 8_000;
const RESPONSE_LIMIT = 64 * 1024;
const COMMAND_ID = /^[A-Za-z0-9-]{8,64}$/;
const COMMAND_ACTIONS = new Set(["check", "update"]);
const RESULT_OUTCOMES = new Set(["up_to_date", "available", "updated", "rolled_back", "failed", "pinned"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOCKET_ERRORS = new Set(["ENOENT", "EACCES", "ECONNREFUSED", "EPERM"]);

const PHASES = ["checking", "pulling", "recreating", "verifying", "rolling_back"];
const boundedDetail = (value) => value == null ? null : [...String(value)].map((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127 ? " " : char).join("").slice(0, 300);
const serviceNames = (values) => [...new Set(values.map((value) => String(value).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64)).filter(Boolean))].slice(0, 8);

export function boundedHistory(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => value && COMMAND_ID.test(value.id ?? "") &&
    Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.finishedAt)) &&
    RESULT_OUTCOMES.has(value.outcome)).slice(0, 5).map((value) => ({
    id: value.id, startedAt: new Date(value.startedAt).toISOString(), finishedAt: new Date(value.finishedAt).toISOString(),
    outcome: value.outcome, detail: boundedDetail(value.detail),
    services: serviceNames(Array.isArray(value.services) ? value.services : []),
    phases: Object.fromEntries(PHASES.map((phase) => [phase, Number.isSafeInteger(value.phases?.[phase]) && value.phases[phase] >= 0 ? value.phases[phase] : 0])),
  }));
}

export async function dockerDiskSpace(where = "/") {
  const stats = await statfs(where);
  return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
}

function gigabytes(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}

export function lowDisk(disk, minBytes = MIN_FREE_DISK_BYTES) {
  return Boolean(disk) && disk.freeBytes < minBytes;
}

function isoNow() {
  return new Date().toISOString();
}

function dockerUnavailable(err) {
  return Boolean(err && typeof err === "object" && SOCKET_ERRORS.has(err.code));
}

function sameRepository(a, b) {
  return Boolean(a && b) && normalizeRepository(a.name) === normalizeRepository(b.name) && a.tag === b.tag;
}

async function mountedContainerId() {
  const text = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    if (fields[4] !== "/etc/hostname") continue;
    const id = /\/containers\/([0-9a-f]{64})\/hostname$/.exec(fields[3] ?? "")?.[1];
    if (id) return id;
  }
  return null;
}

function restorableResult(value) {
  return Boolean(
    value &&
      COMMAND_ACTIONS.has(value.action) &&
      RESULT_OUTCOMES.has(value.outcome) &&
      !Number.isNaN(Date.parse(value.at)) &&
      (value.detail === null || typeof value.detail === "string") &&
      (value.commandId === null || COMMAND_ID.test(String(value.commandId))),
  );
}

export function desiredOf(json) {
  const command = json && typeof json.command === "object" ? json.command : null;
  const valid = command && COMMAND_ID.test(String(command.id)) && COMMAND_ACTIONS.has(command.action);
  return { auto: json?.auto === true, command: valid ? { id: command.id, action: command.action } : null };
}

export function createAgent({
  docker,
  key,
  appUrl,
  projectOverride = null,
  predecessor = "",
  version,
  diskSpace = dockerDiskSpace,
  stateDir = STATE_DIR,
}) {
  const status = {
    state: "idle",
    issue: null,
    image: null,
    tag: null,
    pinned: false,
    targets: 0,
    currentDigest: null,
    latestDigest: null,
    available: false,
    checkedAt: null,
    failedDigest: null,
    lastResult: null,
    ackCommandId: null,
    disk: null,
    progress: null,
    history: [],
  };
  let self = null;
  let project = null;
  const redisSkipped = new Set();
  let stackDue = false;
  let desired = { auto: false, command: null };
  let syncedAt = 0;
  let appReachable = null;
  let syncing = null;
  let syncAgain = false;
  let busy = false;
  let ticking = false;
  let handover = null;
  let nextCheckAt = 0;
  let lastCommandId = null;
  let pendingCommand = null;
  let initialized = false;
  let manualRecovery = false;
  let activeRun = null;
  let saving = Promise.resolve();
  let activeTask = null;
  const timers = [];
  const stateFile = path.join(stateDir, "state.json");
  const journalFile = path.join(stateDir, "transaction.json");
  const heartbeatFile = path.join(stateDir, "heartbeat");

  async function persist() {
    const saved = JSON.stringify({
      failedDigest: status.failedDigest,
      lastResult: status.lastResult,
      ackCommandId: status.ackCommandId,
      pendingCommand,
      history: status.history,
      activeRun,
      progress: status.progress,
    });
    saving = saving.catch(() => undefined).then(async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const file = await open(`${stateFile}.tmp`, "w", 0o600);
      try { await file.writeFile(saved); await file.sync(); } finally { await file.close(); }
      await rename(`${stateFile}.tmp`, stateFile);
      const directory = await open(stateDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    });
    await saving;
  }

  function restoreFrom(text) {
    const saved = parseJson(text);
    status.history = boundedHistory(saved?.history);
    const interrupted = boundedHistory(saved?.activeRun ? [{ ...saved.activeRun, finishedAt: isoNow(), outcome: "failed" }] : [])[0];
    activeRun = interrupted ? { ...interrupted, phase: null, phaseAt: Date.now() } : null;
    if (DIGEST.test(saved?.failedDigest ?? "")) status.failedDigest = saved.failedDigest;
    if (restorableResult(saved?.lastResult)) status.lastResult = saved.lastResult;
    pendingCommand = desiredOf({ command: saved?.pendingCommand }).command;
    if (COMMAND_ID.test(saved?.ackCommandId ?? "")) {
      status.ackCommandId = saved.ackCommandId;
      lastCommandId = saved.ackCommandId;
    }
  }

  async function restore() {
    restoreFrom(await readFile(stateFile, "utf8").catch(() => ""));
  }

  async function heartbeat() {
    await writeFile(heartbeatFile, isoNow(), { mode: 0o600 }).catch((err) =>
      log("warn", "updater.heartbeat_failed", { err: errorMessage(err) }),
    );
  }

  async function postStatus() {
    const report = { version, ...status, history: [...status.history] };
    let body = JSON.stringify(report);
    while (Buffer.byteLength(body) > 16_384 && report.history.length) {
      report.history.pop();
      body = JSON.stringify(report);
    }
    const res = await send(
      {
        protocol: appUrl.protocol,
        hostname: appUrl.hostname.replace(/^\[|\]$/g, ""),
        port: appUrl.port || undefined,
        method: "POST",
        path: "/internal-api/updater",
        timeout: SYNC_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          [UPDATER_HEADER]: signBody(key, body, Date.now()),
        },
      },
      body,
    );
    const text = await readText(res, RESPONSE_LIMIT);
    if (res.statusCode !== 200) throw new Error(`the app answered HTTP ${res.statusCode}`);
    if (verifySignature(key, res.headers[UPDATER_HEADER], text, Date.now(), "response") !== "ok") {
      throw new Error("the app response is not signed with this APP_SECRET");
    }
    desired = desiredOf(parseJson(text));
    syncedAt = Date.now();
  }

  function sync() {
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        try {
          await postStatus();
          if (appReachable !== true) log("info", "updater.app_connected", { app: appUrl.origin });
          appReachable = true;
        } catch (err) {
          if (appReachable !== false) log("warn", "updater.app_unreachable", { app: appUrl.origin, err: errorMessage(err) });
          appReachable = false;
        }
      } while (syncAgain);
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  function accountPhase() {
    if (!activeRun) return;
    const now = Date.now();
    if (PHASES.includes(activeRun.phase)) activeRun.phases[activeRun.phase] += Math.max(0, now - activeRun.phaseAt);
    activeRun.phaseAt = now;
  }

  async function setPhase(state) {
    if (status.state !== state) {
      accountPhase();
      if (activeRun) activeRun.phase = state;
      if (status.progress) status.progress.phaseStartedAt = isoNow();
    }
    status.state = state;
    if (activeRun) await persist();
    void sync();
  }

  function onStartup(startup) {
    if (!status.progress) return;
    const next = startup?.state ?? undefined;
    if (status.progress.startup === next) return;
    status.progress.startup = next;
    void persist().catch((err) => log("warn", "updater.progress_not_saved", { err: errorMessage(err) }));
    void sync();
  }

  async function result(action, outcome, detail, commandId) {
    status.lastResult = {
      action,
      outcome,
      at: isoNow(),
      detail: detail ? String(detail).slice(0, 500) : null,
      commandId: commandId ?? null,
    };
    if (action === "update" && activeRun) {
      accountPhase();
      status.history = boundedHistory([{ ...activeRun, finishedAt: status.lastResult.at, outcome, detail }, ...status.history.filter((entry) => entry.id !== activeRun.id)]);
      activeRun = null;
    }
    const level = outcome === "failed" || outcome === "rolled_back" ? "error" : "info";
    log(level, "updater.result", { action, outcome, ...(detail ? { detail } : {}) });
    if (pendingCommand?.id === commandId) pendingCommand = null;
    await persist();
  }

  async function ensureProject() {
    if (project) return project;
    self ??= await identify();
    project = projectOverride ?? self?.Config?.Labels?.[COMPOSE_PROJECT_LABEL] ?? null;
    return project;
  }

  async function discover() {
    status.issue = null;
    Object.assign(status, { image: null, tag: null, pinned: false, targets: 0, currentDigest: null, latestDigest: null, available: false });
    if (!(await ensureProject())) {
      status.issue = "no_project";
      return null;
    }
    const summaries = await docker.listContainers([`${COMPOSE_PROJECT_LABEL}=${project}`, `${TARGET_LABEL}=true`], true);
    const labeled = (await Promise.all(summaries.map((summary) => docker.inspectContainer(summary.Id)))).filter(
      (container) => container && !isBackup(container),
    );
    const containers = labeled.filter((container) => container.State?.Running === true);
    status.targets = containers.length;
    if (!containers.length) {
      status.issue = "no_targets";
      return null;
    }
    const refs = new Set(containers.map(configuredImageRef));
    if (refs.size !== 1) {
      status.issue = "mixed_images";
      return null;
    }
    const [imageRef] = refs;
    const ref = parseImageRef(imageRef);
    if (!ref) {
      status.issue = "unsupported_image";
      return null;
    }
    status.image = ref.name;
    status.tag = ref.tag;
    status.pinned = isPinned(ref);
    const stopped = labeled.filter((container) => container.State?.Running !== true && configuredImageRef(container) === imageRef);
    return { ref, containers, stopped };
  }

  async function measureDisk() {
    try {
      const disk = await diskSpace();
      status.disk = { freeBytes: Math.floor(disk.freeBytes), totalBytes: Math.floor(disk.totalBytes) };
    } catch (err) {
      status.disk = null;
      log("warn", "updater.disk_unknown", { err: errorMessage(err) });
    }
    return status.disk;
  }

  async function requireDiskSpace(step, minBytes = MIN_FREE_DISK_BYTES) {
    const disk = await measureDisk();
    if (!lowDisk(disk, minBytes)) return;
    log("error", "updater.disk_low", { step, freeBytes: disk.freeBytes, requiredBytes: minBytes });
    throw Object.assign(
      new Error(
        `only ${gigabytes(disk.freeBytes)} GB are free on the Docker disk and an update needs ${gigabytes(minBytes)} GB; free up space, then update again`,
      ),
      { lowDisk: true },
    );
  }

  async function pruneUnusedImages(ref) {
    const dangling = await docker.listDanglingImages().catch((err) => {
      log("warn", "updater.prune_skipped", { err: errorMessage(err) });
      return [];
    });
    const ours = (dangling ?? []).filter((image) => digestsFor(image.RepoDigests, ref.name).length > 0);
    if (!ours.length) return;
    const containers = await docker.listContainers([], true);
    const used = new Set((containers ?? []).map((container) => container.ImageID));
    for (const image of ours) {
      if (used.has(image.Id)) continue;
      try {
        await docker.removeImage(image.Id);
        log("info", "updater.image_pruned", { image: image.Id, sizeBytes: image.Size ?? null });
      } catch (err) {
        log("info", "updater.image_kept", { image: image.Id, err: errorMessage(err) });
      }
    }
  }

  async function runningDigests(target) {
    const ids = [...new Set(target.containers.map((container) => container.Image))];
    const images = await Promise.all(ids.map((id) => docker.inspectImage(id)));
    return images.map((image) => digestsFor(image?.RepoDigests, target.ref.name));
  }

  async function inspectTarget() {
    const target = await discover();
    if (!target) {
      status.available = false;
      return null;
    }
    const digests = await runningDigests(target);
    await measureDisk();
    status.currentDigest = digests[0]?.[0] ?? null;
    status.checkedAt = isoNow();
    if (status.pinned) {
      status.latestDigest = null;
      status.available = false;
      return target;
    }
    try {
      const remote = await docker.distribution(imageRefOf(target.ref));
      if (!DIGEST.test(remote?.Descriptor?.digest ?? "")) throw new Error("the registry returned no valid digest");
      status.latestDigest = remote.Descriptor.digest;
    } catch (err) {
      status.issue = "registry_unreachable";
      status.available = false;
      log("warn", "updater.registry_unreachable", { image: imageRefOf(target.ref), err: errorMessage(err) });
      return null;
    }
    status.available = digests.some((list) => updateAvailable(status.latestDigest, list));
    log("info", "updater.checked", {
      image: imageRefOf(target.ref),
      running: status.currentDigest,
      latest: status.latestDigest,
      available: status.available,
    });
    return target;
  }

  async function check() {
    if (manualRecovery) return null;
    try {
      if (!initialized) await initialize();
      if (manualRecovery) return null;
      await setPhase("checking");
      return await inspectTarget();
    } catch (err) {
      status.issue = dockerUnavailable(err) ? "docker_unavailable" : status.issue;
      status.available = false;
      log("error", "updater.check_failed", { err: errorMessage(err) });
      return null;
    } finally {
      if (status.state === "checking") await setPhase("idle");
    }
  }

  async function removeImages(ids, keep) {
    for (const id of new Set(ids)) {
      if (id === keep) continue;
      const image = await docker.inspectImage(id).catch(() => null);
      if (!image || image.RepoTags?.length) continue;
      try {
        await docker.removeImage(id);
        log("info", "updater.image_removed", { image: id });
      } catch (err) {
        log("info", "updater.image_kept", { image: id, err: errorMessage(err) });
      }
    }
  }

  async function maybeSelfUpdate(ref, image) {
    if (!self || handover || self.Image === image.Id) return;
    if (!sameRepository(parseImageRef(self.Config?.Image), ref)) return;
    const ownImage = await docker.inspectImage(self.Image);
    if (!ownImage) return;
    const nextName = `${containerName(self)}-next`;
    await removeContainerNamed(docker, nextName, null);
    const body = createConfigFor(self, ownImage, {
      imageRef: self.Config.Image,
      imageId: image.Id,
      composeImage: composeImageLabel(self, image),
      env: [`${PREDECESSOR_ENV}=${self.Id}`],
    });
    await persist();
    const created = await docker.create(nextName, body);
    handover = { id: created.Id, until: Date.now() + HANDOVER_TIMEOUT_MS };
    try {
      await docker.start(created.Id);
    } catch (err) {
      await docker.remove(created.Id);
      handover = null;
      throw err;
    }
    log("info", "updater.self_update_started", { successor: shortId(created.Id) });
  }

  async function apply({ commandId, target: checked }) {
    if (manualRecovery) return;
    if (!initialized) await initialize();
    if (manualRecovery) return;
    activeRun = { id: commandId ?? randomUUID(), startedAt: isoNow(), services: [], phases: Object.fromEntries(PHASES.map((phase) => [phase, 0])), phase: null, phaseAt: Date.now() };
    await persist();
    const target = checked ?? (await check());
    if (!target) {
      await result("update", "failed", status.issue, commandId);
      return;
    }
    if (status.pinned) {
      await result("update", "pinned", null, commandId);
      return;
    }
    const targets = [...target.containers, ...target.stopped];
    activeRun.services = serviceNames(targets.map((container) => container.Config?.Labels?.["com.docker.compose.service"] ?? containerName(container)));
    const imageRef = imageRefOf(target.ref);
    let pulled = false;
    status.progress = { startedAt: activeRun.startedAt, phaseStartedAt: isoNow(), service: null, completed: 0, total: targets.length };
    try {
      await pruneUnusedImages(target.ref);
      await requireDiskSpace("pull");
      await setPhase("pulling");
      log("info", "updater.pulling", { image: imageRef });
      const runningImage = await docker.inspectImage(target.containers[0].Image);
      const platform = runningImage?.Os && runningImage?.Architecture
        ? [runningImage.Os, runningImage.Architecture, runningImage.Variant].filter(Boolean).join("/")
        : undefined;
      await docker.pull(target.ref.name, target.ref.tag, { platform, onProgress: (download) => {
        if (status.progress) status.progress.download = download;
        void persist().catch((err) => log("warn", "updater.progress_not_saved", { err: errorMessage(err) }));
        void sync();
      } });
      const image = await docker.inspectImage(imageRef, true);
      if (!image) throw new Error("the pulled image cannot be inspected");
      const freshDigests = digestsFor(image.RepoDigests, target.ref.name);
      if (!status.latestDigest || !freshDigests.includes(status.latestDigest)) {
        throw new Error("the image tag changed during download; check again before updating");
      }
      pulled = true;
      await requireDiskSpace("switch", MIN_SWITCH_DISK_BYTES);
      const stale = targets.filter((container) => container.Image !== image.Id);
      status.progress.total = stale.length;
      let switchAnnounced = false;
      await recreateGroup(docker, stale, { imageRef, image, journalFile,
        waitOptions: { onStartup },
        onPhase: async (phase, progress) => {
          if (progress) Object.assign(status.progress, { service: serviceNames([progress.service ?? ""])[0] ?? null, completed: progress.completed, total: progress.total });
          await setPhase(phase);
          if (phase === "recreating" && !switchAnnounced) {
            await sync();
            switchAnnounced = true;
          }
        },
      });
      status.progress.completed = stale.length;
      status.progress.service = null;
      await removeImages(stale.map((container) => container.Image), image.Id);
      status.currentDigest = freshDigests[0] ?? status.currentDigest;
      status.available = updateAvailable(status.latestDigest, freshDigests);
      status.failedDigest = null;
      await result("update", stale.length ? "updated" : "up_to_date", null, commandId);
      status.progress = null;
      await setPhase("idle");
      await maintainStack();
      await maybeSelfUpdate(target.ref, image).catch((err) =>
        log("error", "updater.self_update_failed", { err: errorMessage(err) }),
      );
    } catch (err) {
      if (err?.committed === true) {
        status.currentDigest = status.latestDigest;
        status.available = false;
        status.failedDigest = null;
        initialized = false;
        await result("update", "updated", `Update installed; backup cleanup will resume: ${errorMessage(err)}`, commandId);
        await setPhase("idle");
        return;
      }
      initialized = false;
      manualRecovery = err?.manualRecovery === true;
      if (manualRecovery && status.progress) status.progress.startup = "manual_recovery";
      const rolledBack = !manualRecovery && err?.rolledBack === true;
      if (pulled && err?.lowDisk !== true) status.failedDigest = status.latestDigest;
      await result("update", rolledBack ? "rolled_back" : "failed", errorMessage(err), commandId);
      await setPhase("failed");
    } finally {
      if (!manualRecovery) status.progress = null;
      void sync();
    }
  }

  async function maintainStack() {
    if (!(await ensureProject())) return;
    try {
      const disk = await measureDisk();
      if (lowDisk(disk)) {
        log("warn", "updater.stack_skipped", { reason: "disk_low", freeBytes: disk.freeBytes });
        return;
      }
      await switchRedisToSnapshots(docker, project, { skip: redisSkipped });
    } catch (err) {
      log("warn", "updater.stack_failed", { err: errorMessage(err) });
    }
  }

  async function scheduledCheck() {
    const target = await check();
    if (!target || status.pinned) return;
    const trusted = Date.now() - syncedAt < AUTO_TRUST_MS;
    if (status.available && desired.auto && trusted && status.latestDigest !== status.failedDigest && !lowDisk(status.disk)) {
      log("info", "updater.auto_update", { digest: status.latestDigest });
      await apply({ commandId: null, target });
      return;
    }
    if (status.available) return;
    const local = await docker.inspectImage(imageRefOf(target.ref), true);
    if (local && target.containers.every((container) => container.Image === local.Id)) {
      await maybeSelfUpdate(target.ref, local);
    }
  }

  async function manualCheck(commandId) {
    const target = await check();
    if (!target) {
      await result("check", "failed", status.issue, commandId);
      return;
    }
    await result("check", status.pinned ? "pinned" : status.available ? "available" : "up_to_date", null, commandId);
  }

  function run(task) {
    busy = true;
    activeTask = task()
      .catch(async (err) => {
        if (dockerUnavailable(err)) status.issue = "docker_unavailable";
        log("error", "updater.task_failed", { err: errorMessage(err), status: err instanceof DockerError ? err.status : undefined });
        status.state = "failed";
        if (pendingCommand) {
          await result(pendingCommand.action, "failed", errorMessage(err), pendingCommand.id).catch((saveError) =>
            log("warn", "updater.state_not_saved", { err: errorMessage(saveError) }),
          );
        }
      })
      .finally(() => {
        busy = false;
        nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
        void sync();
      });
  }

  async function finishHandover() {
    if (!handover || Date.now() < handover.until) return;
    log("warn", "updater.self_update_timed_out", { successor: shortId(handover.id) });
    await docker.remove(handover.id);
    handover = null;
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!initialized) await initialize();
      await sync();
      if (handover) {
        await finishHandover();
        return;
      }
      if (busy || manualRecovery) return;
      if (stackDue) {
        stackDue = false;
        run(maintainStack);
        return;
      }
      const command = pendingCommand ?? desired.command;
      if (command && (pendingCommand || command.id !== lastCommandId)) {
        pendingCommand = command;
        await persist();
        lastCommandId = command.id;
        status.ackCommandId = command.id;
        log("info", "updater.command", { action: command.action });
        run(() => (command.action === "check" ? manualCheck(command.id) : apply({ commandId: command.id })));
        return;
      }
      if (Date.now() >= nextCheckAt) {
        nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
        run(scheduledCheck);
      }
    } catch (err) {
      if (dockerUnavailable(err)) status.issue = "docker_unavailable";
      log("error", "updater.tick_failed", { err: errorMessage(err) });
      void sync();
    } finally {
      ticking = false;
    }
  }

  async function identify() {
    for (const candidate of [os.hostname(), await mountedContainerId()]) {
      if (!candidate) continue;
      const info = await docker.inspectContainer(candidate);
      if (info) return info;
    }
    return null;
  }

  async function adoptPredecessor() {
    if (!self || !predecessor || predecessor === self.Id) return;
    const previous = await docker.inspectContainer(predecessor);
    const name = containerName(self);
    const original = previous ? containerName(previous) : name.replace(/-next$/, "");
    if (previous) {
      const ownProject = self.Config?.Labels?.[COMPOSE_PROJECT_LABEL];
      if (!ownProject || previous.Config?.Labels?.[COMPOSE_PROJECT_LABEL] !== ownProject ||
          previous.Config?.Labels?.["com.docker.compose.service"] !== self.Config?.Labels?.["com.docker.compose.service"]) {
        throw new Error("the predecessor does not belong to this updater service");
      }
      const inherited = await docker.readFile(previous.Id, STATE_FILE).catch((err) => {
        if (err instanceof DockerError && err.status === 404) return "{}";
        throw err;
      });
      if (!inherited || !parseJson(inherited)) throw new Error("the predecessor state is unavailable");
      if (inherited) {
        restoreFrom(inherited);
        await persist();
      }
      const inheritedLogs = await docker.logs(previous.Id, PREDECESSOR_LOG_LINES).catch((err) => {
        log("warn", "updater.predecessor_logs_unavailable", { err: errorMessage(err) });
        return "";
      });
      replayLogText(inheritedLogs);
      await docker.stop(previous.Id, 10).catch((err) => log("warn", "updater.predecessor_not_stopped", { err: errorMessage(err) }));
      await docker.remove(previous.Id);
      log("info", "updater.self_updated", { replaced: shortId(previous.Id) });
      stackDue = true;
      await removeImages([previous.Image], self.Image);
    }
    if (name !== original && !(await docker.inspectContainer(original))) {
      await docker.rename(self.Id, original);
      self = await docker.inspectContainer(self.Id);
    }
  }

  async function initialize() {
    self = await identify();
    await adoptPredecessor();
    project = projectOverride ?? self?.Config?.Labels?.[COMPOSE_PROJECT_LABEL] ?? null;
    if (!project) {
      status.issue = "no_project";
      throw new Error("the updater compose project cannot be identified");
    }
    let recovery = null;
    try {
      recovery = await recoverGroup(docker, `${COMPOSE_PROJECT_LABEL}=${project}`, { journalFile, onPhase: setPhase, waitOptions: { onStartup } });
      await recoverLeftovers(docker, `${COMPOSE_PROJECT_LABEL}=${project}`);
    } catch (err) {
      if (err?.manualRecovery !== true) throw err;
      manualRecovery = true;
      status.state = "failed";
      status.progress = { startedAt: activeRun?.startedAt ?? isoNow(), phaseStartedAt: isoNow(), service: null, completed: 0, total: 0, startup: "manual_recovery" };
      if (activeRun) await result("update", "failed", errorMessage(err), pendingCommand?.id);
    }
    if (activeRun) await result("update", recovery?.recovered ? (recovery.committed ? "updated" : "rolled_back") : "failed", "Updater restarted during this update; recovery completed before further work", pendingCommand?.id);
    initialized = true;
  }

  async function start() {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await heartbeat();
    await restore();
    log("info", "updater.started", {
      version,
      project,
      container: self ? shortId(self.Id) : null,
      app: appUrl.origin,
    });
    timers.push(setInterval(() => void heartbeat(), SYNC_INTERVAL_MS));
    timers.push(setInterval(() => void tick(), SYNC_INTERVAL_MS));
    await tick();
  }

  async function stop() {
    for (const timer of timers) clearInterval(timer);
    await activeTask;
    await syncing;
    await saving;
  }

  return { start, stop, status, tick, check, apply };
}
