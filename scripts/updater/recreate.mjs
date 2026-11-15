import { setTimeout as sleep } from "node:timers/promises";
import { composeImageLabel, containerName, createConfigFor, hasHealthcheck, stopSeconds } from "./container-config.mjs";
import { inspectStartup } from "./startup.mjs";
import { errorMessage, log } from "./log.mjs";

export const BACKUP_SUFFIX = "-llmhub-old";
const STOPPED_BACKUP_SUFFIX = "-llmhub-stopped-old";
export const HEALTHY_TIMEOUT_MS = 10 * 60_000;
export const SETTLE_MS = 20_000;
export const PORT_RELEASE_TIMEOUT_MS = 15_000;
export const UPDATE_DRAIN_SECONDS = 30;
export const CRASH_LOOP_RESTARTS = 3;
const POLL_MS = 2_000;
const FAILED_LOG_LINES = 40;
const START_OLD_ATTEMPTS = 3;
const START_OLD_RETRY_MS = 1_000;
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

function publishedPorts(info) {
  const ports = info?.NetworkSettings?.Ports;
  if (!ports) return false;
  return Object.values(ports).some((bindings) => Array.isArray(bindings) && bindings.length > 0);
}

export async function waitStopped(docker, id, { timeoutMs = PORT_RELEASE_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const info = await docker.inspectContainer(id);
    if (!info || (info.State?.Running !== true && !publishedPorts(info))) return;
    if (Date.now() - startedAt >= timeoutMs) throw new Error("the old container did not release its ports in time");
    await sleep(pollMs);
  }
}

export async function waitHealthy(
  docker,
  id,
  { healthyTimeoutMs = HEALTHY_TIMEOUT_MS, settleMs = SETTLE_MS, pollMs = POLL_MS, crashLoopRestarts = CRASH_LOOP_RESTARTS, onStartup = (status) => { void status; } } = {},
) {
  let startedAt = Date.now();
  let previousStartup;
  for (;;) {
    const info = await docker.inspectContainer(id);
    if (!info) throw Object.assign(new Error("the new container disappeared"), previousStartup?.rollbackSafe === false
      ? { manualRecovery: true, startup: previousStartup } : {});
    const startup = typeof docker.readFile === "function" ? await inspectStartup(docker, id, info) : { decision: "legacy", state: null };
    previousStartup = startup;
    await onStartup?.(startup);
    const failure = (message) => Object.assign(new Error(message), startup.rollbackSafe === false || startup.decision === "manual_recovery"
      ? { manualRecovery: true, startup } : {});
    if (startup.decision === "manual_recovery") throw failure(startup.reason ?? "startup requires manual recovery");
    if (startup.decision === "wait") {
      startedAt = Date.now();
      await sleep(pollMs);
      continue;
    }
    const state = info.State ?? {};
    if (completedJob(info)) return;
    const elapsed = Date.now() - startedAt;
    if (hasHealthcheck(info)) {
      const health = state.Health?.Status;
      if (health === "healthy" && state.Running !== false && !state.Restarting && !state.Paused && state.Status === "running") return;
      if (health === "unhealthy") throw failure("the new container reported unhealthy");
      if ((info.RestartCount ?? 0) >= crashLoopRestarts) {
        throw failure(`the new container restarted ${info.RestartCount} times without becoming healthy`);
      }
      if (state.Status === "exited" || state.Status === "dead") {
        throw failure(`the new container stopped with exit code ${state.ExitCode ?? "unknown"}`);
      }
      if (elapsed >= healthyTimeoutMs) throw failure("the new container did not become healthy in time");
    } else {
      if (state.Status === "exited" || state.Status === "dead" || state.Restarting || (info.RestartCount ?? 0) > 0) {
        throw failure(`the new container stopped with exit code ${state.ExitCode ?? "unknown"}`);
      }
      if (state.Status === "running" && state.Running !== false && !state.Paused && elapsed >= settleMs) return;
      if (elapsed >= healthyTimeoutMs) throw failure("the new container did not start in time");
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

async function attemptTimes(step, fn, times = START_OLD_ATTEMPTS) {
  for (let i = 1; i <= times; i += 1) {
    try {
      await fn();
      return true;
    } catch (err) {
      log("error", "updater.rollback_step_failed", { step, attempt: i, err: errorMessage(err) });
      if (i < times) await sleep(START_OLD_RETRY_MS);
    }
  }
  return false;
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

function keepConfig(body) {
  return body;
}

export async function recreateContainer(
  docker,
  container,
  { imageRef, image, onPhase, waitOptions, configure = keepConfig, cleanStop = false },
) {
  const name = containerName(container);
  const backup = `${name}${BACKUP_SUFFIX}`;
  const oldImage = await docker.inspectImage(container.Image);
  if (!oldImage) throw new Error(`the image of ${name} cannot be inspected`);
  const graceSeconds = stopSeconds(container);
  const drainSeconds = Math.min(graceSeconds, UPDATE_DRAIN_SECONDS);
  const body = createConfigFor(container, oldImage, {
    imageRef,
    imageId: image.Id,
    composeImage: composeImageLabel(container, image),
    stopTimeout: graceSeconds,
  });
  configure(body);
  const wasRunning = container.State?.Running === true;
  const progress = { stopRequested: false, renameRequested: false, renamed: false, createRequested: false, created: null };
  try {
    await onPhase("recreating");
    if (await docker.inspectContainer(backup)) throw new Error(`unresolved backup ${backup} must be recovered first`);
    log("info", "updater.container_stopping", { container: name, drainSeconds });
    const stoppingAt = Date.now();
    progress.stopRequested = true;
    await docker.stop(container.Id, drainSeconds);
    await waitStopped(docker, container.Id, waitOptions);
    if (cleanStop) {
      const exitCode = (await docker.inspectContainer(container.Id))?.State?.ExitCode;
      if (exitCode !== 0) throw new Error(`${name} did not shut down cleanly (exit code ${exitCode ?? "unknown"})`);
    }
    log("info", "updater.container_stopped", { container: name, durationMs: Date.now() - stoppingAt });
    progress.renameRequested = true;
    await docker.rename(container.Id, backup);
    progress.renamed = true;
    progress.createRequested = true;
    progress.created = (await docker.create(name, body)).Id;
    await docker.start(progress.created);
    log("info", "updater.container_started", { container: name, image: imageRef });
    await onPhase("verifying");
    await waitHealthy(docker, progress.created, waitOptions);
  } catch (err) {
    if (err.manualRecovery) throw err;
    await attempt("report_rollback", () => onPhase("rolling_back"));
    log("error", "updater.recreate_failed", { container: name, err: errorMessage(err) });
    let restored = true;
    if (progress.renameRequested) {
      restored = await attempt("reconcile_old", async () => {
        const old = await docker.inspectContainer(container.Id);
        if (old?.Name) progress.renamed ||= containerName(old) === backup;
      });
    }
    if (progress.createRequested && !progress.created) {
      restored = (await attempt("reconcile_new", async () => {
        const current = await docker.inspectContainer(name);
        if (current && current.Id !== container.Id) progress.created = current.Id;
      })) && restored;
    }
    if (progress.created) {
      await recordFailedLogs(docker, progress.created, name);
      restored = (await attempt("remove_new", () => docker.remove(progress.created))) && restored;
    }
    if (progress.stopRequested && wasRunning && restored) {
      restored = await attempt("wait_old_stopped", () => waitStopped(docker, container.Id, {
        ...waitOptions,
        timeoutMs: waitOptions?.timeoutMs ?? (drainSeconds + 30) * 1000,
      }));
      if (restored) restored = await attemptTimes("start_old", () => docker.start(container.Id));
    }
    if (progress.renamed && restored) restored = await attempt("rename_old", () => docker.rename(container.Id, name));
    log(restored ? "warn" : "error", restored ? "updater.rolled_back" : "updater.rollback_incomplete", { container: name });
    throw Object.assign(new Error(restored ? errorMessage(err) : `${errorMessage(err)}; the rollback did not complete`), {
      rolledBack: restored,
    });
  }
  await attempt("remove_old", () => docker.remove(container.Id));
  return { id: progress.created, name, oldImageId: container.Image };
}

export function isBackup(container) {
  const name = containerName(container);
  return name.endsWith(BACKUP_SUFFIX) || name.endsWith(STOPPED_BACKUP_SUFFIX) || /-llmhub-tx-[a-f0-9-]{36}$/.test(name);
}

export async function replaceStoppedContainers(docker, containers, { imageRef, image }) {
  const replaced = [];
  for (const container of containers) {
    if (container.Image === image.Id) continue;
    const name = containerName(container);
    const backup = `${name}${STOPPED_BACKUP_SUFFIX}`;
    let renameRequested = false;
    let createRequested = false;
    try {
      if (await docker.inspectContainer(backup)) throw new Error(`unresolved backup ${backup} must be recovered first`);
      const oldImage = await docker.inspectImage(container.Image);
      if (!oldImage) throw new Error(`the image of ${name} cannot be inspected`);
      const body = createConfigFor(container, oldImage, {
        imageRef,
        imageId: image.Id,
        composeImage: composeImageLabel(container, image),
      });
      renameRequested = true;
      await docker.rename(container.Id, backup);
      createRequested = true;
      await docker.create(name, body);
      await docker.remove(container.Id);
      replaced.push(container);
      log("info", "updater.stopped_container_replaced", { container: name, image: imageRef });
    } catch (err) {
      if (renameRequested) await attempt("restore_stopped", async () => {
        const old = await docker.inspectContainer(container.Id);
        if (!old) return;
        if (createRequested) await removeContainerNamed(docker, name, container.Id);
        await docker.rename(container.Id, name);
      });
      log("warn", "updater.stopped_container_not_replaced", { container: name, err: errorMessage(err) });
    }
  }
  return replaced;
}

export async function recoverLeftovers(docker, projectLabel, waitOptions) {
  const containers = await docker.listContainers([projectLabel], true);
  for (const summary of containers) {
    const backupName = (summary.Names ?? []).map((value) => value.replace(/^\//, "")).find((value) => value.endsWith(BACKUP_SUFFIX) || value.endsWith(STOPPED_BACKUP_SUFFIX));
    if (!backupName) continue;
    const stopped = backupName.endsWith(STOPPED_BACKUP_SUFFIX);
    const name = backupName.slice(0, -(stopped ? STOPPED_BACKUP_SUFFIX : BACKUP_SUFFIX).length);
    const current = await docker.inspectContainer(name);
    if (current) {
      let verified = stopped;
      if (!stopped) {
        try { await waitHealthy(docker, current.Id, waitOptions); verified = true; }
        catch (err) {
          if (err.manualRecovery) throw err;
          log("warn", "updater.leftover_unhealthy", { err: errorMessage(err) });
        }
      }
      if (verified) {
        if (await attempt("remove_leftover", () => docker.remove(summary.Id))) {
          log("info", "updater.leftover_removed", { container: backupName });
        }
        continue;
      }
      if (!await attempt("remove_broken", () => docker.remove(current.Id))) continue;
    }
    if (!stopped && !await attemptTimes("restore_start", () => docker.start(summary.Id))) continue;
    if (!await attempt("restore_name", () => docker.rename(summary.Id, name))) continue;
    log("warn", "updater.leftover_restored", { container: name });
  }
}
