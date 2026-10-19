import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setInterval } from "node:timers";
import { COMPOSE_PROJECT_LABEL, composeImageLabel, containerName, createConfigFor, shortId } from "./container-config.mjs";
import { DockerError } from "./docker.mjs";
import { parseJson, readText, send } from "./http.mjs";
import { digestsFor, imageRefOf, isPinned, normalizeRepository, parseImageRef, updateAvailable } from "./image-ref.mjs";
import { errorMessage, log } from "./log.mjs";
import { recoverLeftovers, recreateContainer, removeContainerNamed } from "./recreate.mjs";
import { signBody, UPDATER_HEADER, verifySignature } from "./signature.mjs";

export const TARGET_LABEL = "llmhub.updater.target";
export const PREDECESSOR_ENV = "LLMHUB_UPDATER_PREDECESSOR";
export const SYNC_INTERVAL_MS = 10_000;
export const CHECK_INTERVAL_MS = 5 * 60_000;
export const AUTO_TRUST_MS = 5 * 60_000;
export const HANDOVER_TIMEOUT_MS = 2 * 60_000;
export const STATE_DIR = path.join(os.homedir(), ".llmhub-updater");
export const HEARTBEAT_FILE = path.join(STATE_DIR, "heartbeat");
export const HEARTBEAT_MAX_AGE_MS = 90_000;

const STATE_FILE = path.join(STATE_DIR, "state.json");
const SYNC_TIMEOUT_MS = 8_000;
const RESPONSE_LIMIT = 64 * 1024;
const COMMAND_ID = /^[A-Za-z0-9-]{8,64}$/;
const COMMAND_ACTIONS = new Set(["check", "update"]);
const RESULT_OUTCOMES = new Set(["up_to_date", "available", "updated", "rolled_back", "failed", "pinned"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOCKET_ERRORS = new Set(["ENOENT", "EACCES", "ECONNREFUSED", "EPERM"]);

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

export function createAgent({ docker, key, appUrl, projectOverride = null, predecessor = null, version }) {
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
  };
  let self = null;
  let project = null;
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

  async function persist() {
    const saved = JSON.stringify({
      failedDigest: status.failedDigest,
      lastResult: status.lastResult,
      ackCommandId: status.ackCommandId,
    });
    await writeFile(STATE_FILE, saved).catch((err) => log("warn", "updater.state_not_saved", { err: errorMessage(err) }));
  }

  function restoreFrom(text) {
    const saved = parseJson(text);
    if (DIGEST.test(saved?.failedDigest ?? "")) status.failedDigest = saved.failedDigest;
    if (restorableResult(saved?.lastResult)) status.lastResult = saved.lastResult;
    if (COMMAND_ID.test(saved?.ackCommandId ?? "")) {
      status.ackCommandId = saved.ackCommandId;
      lastCommandId = saved.ackCommandId;
    }
  }

  async function restore() {
    restoreFrom(await readFile(STATE_FILE, "utf8").catch(() => ""));
  }

  async function heartbeat() {
    await writeFile(HEARTBEAT_FILE, isoNow()).catch((err) =>
      log("warn", "updater.heartbeat_failed", { err: errorMessage(err) }),
    );
  }

  async function postStatus() {
    const body = JSON.stringify({ version, ...status });
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

  function setPhase(state) {
    status.state = state;
    return sync();
  }

  function result(action, outcome, detail, commandId) {
    status.lastResult = {
      action,
      outcome,
      at: isoNow(),
      detail: detail ? String(detail).slice(0, 500) : null,
      commandId: commandId ?? null,
    };
    const level = outcome === "failed" || outcome === "rolled_back" ? "error" : "info";
    log(level, "updater.result", { action, outcome, ...(detail ? { detail } : {}) });
    void persist();
  }

  async function ensureProject() {
    if (project) return project;
    self ??= await identify();
    project = projectOverride ?? self?.Config?.Labels?.[COMPOSE_PROJECT_LABEL] ?? null;
    return project;
  }

  async function discover() {
    status.issue = null;
    if (!(await ensureProject())) {
      status.issue = "no_project";
      return null;
    }
    const summaries = await docker.listContainers([`${COMPOSE_PROJECT_LABEL}=${project}`, `${TARGET_LABEL}=true`]);
    const containers = (await Promise.all(summaries.map((summary) => docker.inspectContainer(summary.Id)))).filter(Boolean);
    status.targets = containers.length;
    if (!containers.length) {
      status.issue = "no_targets";
      return null;
    }
    const refs = new Set(containers.map((container) => container.Config?.Image));
    if (refs.size !== 1) {
      status.issue = "mixed_images";
      return null;
    }
    const ref = parseImageRef([...refs][0]);
    if (!ref) {
      status.issue = "unsupported_image";
      return null;
    }
    status.image = ref.name;
    status.tag = ref.tag;
    status.pinned = isPinned(ref);
    return { ref, containers };
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
    status.currentDigest = digests[0]?.[0] ?? null;
    status.checkedAt = isoNow();
    if (status.pinned) {
      status.latestDigest = null;
      status.available = false;
      return target;
    }
    try {
      const remote = await docker.distribution(imageRefOf(target.ref));
      status.latestDigest = typeof remote?.Descriptor?.digest === "string" ? remote.Descriptor.digest : null;
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
    await setPhase("checking");
    try {
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
    const created = await docker.create(nextName, body);
    await docker.start(created.Id);
    handover = { id: created.Id, until: Date.now() + HANDOVER_TIMEOUT_MS };
    log("info", "updater.self_update_started", { successor: shortId(created.Id) });
  }

  async function apply({ commandId, target: checked }) {
    const target = checked ?? (await check());
    if (!target) {
      result("update", "failed", status.issue, commandId);
      return;
    }
    if (status.pinned) {
      result("update", "pinned", null, commandId);
      return;
    }
    const imageRef = imageRefOf(target.ref);
    let pulled = false;
    try {
      await setPhase("pulling");
      log("info", "updater.pulling", { image: imageRef });
      await docker.pull(target.ref.name, target.ref.tag);
      pulled = true;
      const image = await docker.inspectImage(imageRef, true);
      if (!image) throw new Error("the pulled image cannot be inspected");
      const stale = target.containers.filter((container) => container.Image !== image.Id);
      const freshDigests = digestsFor(image.RepoDigests, target.ref.name);
      if (stale.length) {
        for (const container of stale) {
          await recreateContainer(docker, container, { imageRef, image, onPhase: setPhase });
        }
        await removeImages(stale.map((container) => container.Image), image.Id);
      }
      status.currentDigest = freshDigests[0] ?? status.currentDigest;
      status.available = updateAvailable(status.latestDigest, freshDigests);
      status.failedDigest = null;
      result("update", stale.length ? "updated" : "up_to_date", null, commandId);
      await setPhase("idle");
      await maybeSelfUpdate(target.ref, image).catch((err) =>
        log("error", "updater.self_update_failed", { err: errorMessage(err) }),
      );
    } catch (err) {
      const rolledBack = err?.rolledBack === true;
      if (pulled) status.failedDigest = status.latestDigest;
      result("update", rolledBack ? "rolled_back" : "failed", errorMessage(err), commandId);
      await setPhase("failed");
    }
  }

  async function scheduledCheck() {
    const target = await check();
    if (!target || status.pinned) return;
    const trusted = Date.now() - syncedAt < AUTO_TRUST_MS;
    if (status.available && desired.auto && trusted && status.latestDigest !== status.failedDigest) {
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
      result("check", "failed", status.issue, commandId);
      return;
    }
    result("check", status.pinned ? "pinned" : status.available ? "available" : "up_to_date", null, commandId);
  }

  function run(task) {
    busy = true;
    task()
      .catch((err) => {
        if (dockerUnavailable(err)) status.issue = "docker_unavailable";
        log("error", "updater.task_failed", { err: errorMessage(err), status: err instanceof DockerError ? err.status : undefined });
        status.state = status.state === "checking" ? "idle" : status.state;
      })
      .finally(() => {
        busy = false;
        void sync();
      });
  }

  async function finishHandover() {
    if (!handover || Date.now() < handover.until) return;
    log("warn", "updater.self_update_timed_out", { successor: shortId(handover.id) });
    await docker.remove(handover.id).catch((err) => log("warn", "updater.successor_not_removed", { err: errorMessage(err) }));
    handover = null;
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await sync();
      if (handover) {
        await finishHandover();
        return;
      }
      if (busy) return;
      const command = desired.command;
      if (command && command.id !== lastCommandId) {
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
      const inherited = await docker.readFile(previous.Id, STATE_FILE).catch(() => null);
      if (inherited) {
        restoreFrom(inherited);
        await persist();
      }
      await docker.stop(previous.Id, 10).catch((err) => log("warn", "updater.predecessor_not_stopped", { err: errorMessage(err) }));
      await docker.remove(previous.Id);
      log("info", "updater.self_updated", { replaced: shortId(previous.Id) });
      await removeImages([previous.Image], self.Image);
    }
    if (name !== original && !(await docker.inspectContainer(original))) {
      await docker.rename(self.Id, original);
      self = await docker.inspectContainer(self.Id);
    }
  }

  async function start() {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 }).catch((err) =>
      log("warn", "updater.state_dir_failed", { err: errorMessage(err) }),
    );
    await heartbeat();
    await restore();
    try {
      self = await identify();
      await adoptPredecessor();
      project = projectOverride ?? self?.Config?.Labels?.[COMPOSE_PROJECT_LABEL] ?? null;
      if (project) await recoverLeftovers(docker, `${COMPOSE_PROJECT_LABEL}=${project}`);
    } catch (err) {
      if (dockerUnavailable(err)) status.issue = "docker_unavailable";
      log("error", "updater.start_failed", { err: errorMessage(err) });
    }
    log("info", "updater.started", {
      version,
      project,
      container: self ? shortId(self.Id) : null,
      app: appUrl.origin,
    });
    setInterval(() => void heartbeat(), SYNC_INTERVAL_MS);
    setInterval(() => void tick(), SYNC_INTERVAL_MS);
    await tick();
  }

  return { start, status, tick, check, apply };
}
