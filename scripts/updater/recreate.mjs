import { setTimeout as sleep } from "node:timers/promises";
import { composeImageLabel, containerName, createConfigFor, hasHealthcheck, stopSeconds } from "./container-config.mjs";
import { errorMessage, log } from "./log.mjs";

export const BACKUP_SUFFIX = "-llmhub-old";
export const HEALTHY_TIMEOUT_MS = 10 * 60_000;
export const SETTLE_MS = 20_000;
const POLL_MS = 2_000;
const FAILED_LOG_LINES = 40;
const RESTARTING_POLICIES = new Set(["always", "unless-stopped"]);

function completedJob(info) {
  const policy = info.HostConfig?.RestartPolicy?.Name ?? "";
  return (
    info.State?.Status === "exited" &&
    info.State.ExitCode === 0 &&
    (info.RestartCount ?? 0) === 0 &&
    !RESTARTING_POLICIES.has(policy)
  );
}

export async function waitHealthy(docker, id, { healthyTimeoutMs = HEALTHY_TIMEOUT_MS, settleMs = SETTLE_MS, pollMs = POLL_MS } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const info = await docker.inspectContainer(id);
    if (!info) throw new Error("the new container disappeared");
    const state = info.State ?? {};
    if (completedJob(info)) return;
    if (state.Status === "exited" || state.Status === "dead" || state.Restarting || (info.RestartCount ?? 0) > 0) {
      throw new Error(`the new container stopped with exit code ${state.ExitCode ?? "unknown"}`);
    }
    const elapsed = Date.now() - startedAt;
    if (hasHealthcheck(info)) {
      const health = state.Health?.Status;
      if (health === "healthy") return;
      if (health === "unhealthy") throw new Error("the new container reported unhealthy");
      if (elapsed >= healthyTimeoutMs) throw new Error("the new container did not become healthy in time");
    } else if (elapsed >= settleMs) {
      return;
    }
    await sleep(pollMs);
  }
}

async function attempt(step, fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    log("error", "updater.rollback_step_failed", { step, err: errorMessage(err) });
    return false;
  }
}

async function recordFailedLogs(docker, id, name) {
  try {
    const lines = (await docker.logs(id, FAILED_LOG_LINES)).split("\n").filter(Boolean);
    log("warn", "updater.failed_container_logs", { container: name, lines });
  } catch (err) {
    log("warn", "updater.failed_container_logs_unavailable", { container: name, err: errorMessage(err) });
  }
}

export async function removeContainerNamed(docker, name, keepId) {
  const existing = await docker.inspectContainer(name);
  if (!existing || existing.Id === keepId) return false;
  await docker.remove(existing.Id);
  return true;
}

export async function recreateContainer(docker, container, { imageRef, image, onPhase, waitOptions }) {
  const name = containerName(container);
  const backup = `${name}${BACKUP_SUFFIX}`;
  const oldImage = await docker.inspectImage(container.Image);
  if (!oldImage) throw new Error(`the image of ${name} cannot be inspected`);
  const graceSeconds = stopSeconds(container);
  const body = createConfigFor(container, oldImage, {
    imageRef,
    imageId: image.Id,
    composeImage: composeImageLabel(container, image),
    stopTimeout: graceSeconds,
  });
  const wasRunning = container.State?.Running === true;
  const progress = { stopped: false, renamed: false, created: null };
  try {
    await onPhase("recreating");
    await removeContainerNamed(docker, backup, container.Id);
    await docker.stop(container.Id, graceSeconds);
    progress.stopped = true;
    await docker.rename(container.Id, backup);
    progress.renamed = true;
    progress.created = (await docker.create(name, body)).Id;
    await docker.start(progress.created);
    log("info", "updater.container_started", { container: name, image: imageRef });
    await onPhase("verifying");
    await waitHealthy(docker, progress.created, waitOptions);
  } catch (err) {
    await onPhase("rolling_back");
    log("error", "updater.recreate_failed", { container: name, err: errorMessage(err) });
    let restored = true;
    if (progress.created) {
      await recordFailedLogs(docker, progress.created, name);
      restored = (await attempt("remove_new", () => docker.remove(progress.created))) && restored;
    }
    if (progress.renamed) restored = (await attempt("rename_old", () => docker.rename(container.Id, name))) && restored;
    if (progress.stopped && wasRunning) restored = (await attempt("start_old", () => docker.start(container.Id))) && restored;
    log(restored ? "warn" : "error", restored ? "updater.rolled_back" : "updater.rollback_incomplete", { container: name });
    throw Object.assign(new Error(restored ? errorMessage(err) : `${errorMessage(err)}; the rollback did not complete`), {
      rolledBack: restored,
    });
  }
  await attempt("remove_old", () => docker.remove(container.Id));
  return { id: progress.created, name, oldImageId: container.Image };
}

export function isBackup(container) {
  return containerName(container).endsWith(BACKUP_SUFFIX);
}

export async function replaceStoppedContainers(docker, containers, { imageRef, image }) {
  const replaced = [];
  for (const container of containers) {
    if (container.Image === image.Id) continue;
    const name = containerName(container);
    try {
      const oldImage = await docker.inspectImage(container.Image);
      if (!oldImage) throw new Error(`the image of ${name} cannot be inspected`);
      const body = createConfigFor(container, oldImage, {
        imageRef,
        imageId: image.Id,
        composeImage: composeImageLabel(container, image),
      });
      await docker.remove(container.Id);
      await docker.create(name, body);
      replaced.push(container);
      log("info", "updater.stopped_container_replaced", { container: name, image: imageRef });
    } catch (err) {
      log("warn", "updater.stopped_container_not_replaced", { container: name, err: errorMessage(err) });
    }
  }
  return replaced;
}

export async function recoverLeftovers(docker, projectLabel) {
  const containers = await docker.listContainers([projectLabel], true);
  for (const summary of containers) {
    const backupName = (summary.Names ?? []).map((value) => value.replace(/^\//, "")).find((value) => value.endsWith(BACKUP_SUFFIX));
    if (!backupName) continue;
    const name = backupName.slice(0, -BACKUP_SUFFIX.length);
    const current = await docker.inspectContainer(name);
    if (current?.State?.Running) {
      await attempt("remove_leftover", () => docker.remove(summary.Id));
      log("info", "updater.leftover_removed", { container: backupName });
      continue;
    }
    if (current) await attempt("remove_broken", () => docker.remove(current.Id));
    await attempt("restore_name", () => docker.rename(summary.Id, name));
    await attempt("restore_start", () => docker.start(summary.Id));
    log("warn", "updater.leftover_restored", { container: name });
  }
}
