import "server-only";

import { logger } from "@/lib/logging/logger";
import { jobsEnabled } from "@/lib/jobs/connection";
import { claimLease } from "@/lib/jobs/lease";
import { closeQueues } from "@/lib/jobs/queues";
import { sharedRedis, withRedisTimeout } from "@/lib/redis/client";
import { setWorkerMode } from "./health";
import type { GlobalWithWorkerBoot } from "@/types/jobs";

const WORKER_TICK_MS = 60_000;
const MODEL_SYNC_TICK_MS = 7_200_000;
const MAINTENANCE_LEASE = "maintenance_sweep_lock";
const MAINTENANCE_LEASE_MS = 55_000;
const BULLMQ_RETRY_BASE_MS = 5_000;
const BULLMQ_RETRY_MAX_MS = 300_000;
const BULLMQ_START_TIMEOUT_MS = 10_000;

export const BOOT_KEY = "__llmhubWorkerBoot";

export function bullmqRetryDelay(attempt: number): number {
  const exponent = Math.min(Math.max(0, Math.trunc(attempt) - 1), 16);
  return Math.min(BULLMQ_RETRY_MAX_MS, BULLMQ_RETRY_BASE_MS * 2 ** exponent);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function startLocalModelSync(g: GlobalWithWorkerBoot): void {
  if (g.__llmhubModelSyncTimer) return;
  const sync = () =>
    import("./model-sync")
      .then(({ runModelSync }) => runModelSync())
      .catch((err) => {
        logger.error("worker.model_sync_failed", { err: errorMessage(err) });
      });
  void sync();
  const timer = setInterval(sync, MODEL_SYNC_TICK_MS);
  timer.unref();
  g.__llmhubModelSyncTimer = timer;
}

async function leasedMaintenanceSweep() {
  if (!(await claimLease(MAINTENANCE_LEASE, MAINTENANCE_LEASE_MS))) return null;
  const { runMaintenanceSweep } = await import("./jobs");
  return runMaintenanceSweep();
}

function startLocalTimer(g: GlobalWithWorkerBoot): void {
  startLocalModelSync(g);
  if (g.__llmhubWorkerTimer) return;
  const tick = () =>
    leasedMaintenanceSweep()
      .then((result) => {
        if (result && Object.values(result).some((n) => n > 0)) {
          logger.info("worker.tick", result);
        }
      })
      .catch((err) => {
        logger.error("worker.tick_failed", { err: errorMessage(err) });
      });
  void tick();
  const timer = setInterval(tick, WORKER_TICK_MS);
  timer.unref();
  g.__llmhubWorkerTimer = timer;
}

function stopLocalTimers(g: GlobalWithWorkerBoot): void {
  if (g.__llmhubWorkerTimer) {
    clearInterval(g.__llmhubWorkerTimer);
    g.__llmhubWorkerTimer = undefined;
  }
  if (g.__llmhubModelSyncTimer) {
    clearInterval(g.__llmhubModelSyncTimer);
    g.__llmhubModelSyncTimer = undefined;
  }
}

async function closeQueueWorkers(g: GlobalWithWorkerBoot): Promise<void> {
  const workers = g.__llmhubQueueWorkers ?? [];
  g.__llmhubQueueWorkers = undefined;
  await Promise.allSettled(workers.map((worker) => worker.close()));
}

async function assertRedisReachable(): Promise<void> {
  const redis = await sharedRedis();
  if (!redis) throw new Error("Redis is unreachable");
  await withRedisTimeout(redis.ping());
}

async function startQueueWorkers(g: GlobalWithWorkerBoot): Promise<string[]> {
  await assertRedisReachable();
  const { buildQueueWorkers } = await import("./consumers");
  const { registerWorkerSchedules } = await import("./schedules");
  const workers = buildQueueWorkers();
  g.__llmhubQueueWorkers = workers;
  try {
    await withRedisTimeout(registerWorkerSchedules(), BULLMQ_START_TIMEOUT_MS);
  } catch (err) {
    await withRedisTimeout(closeQueueWorkers(g), BULLMQ_START_TIMEOUT_MS).catch(() => undefined);
    await withRedisTimeout(closeQueues(), BULLMQ_START_TIMEOUT_MS).catch(() => undefined);
    throw err;
  }
  return workers.map((worker) => worker.name);
}

async function bootWorker(): Promise<void> {
  const g = globalThis as GlobalWithWorkerBoot;
  if (g[BOOT_KEY]) return g[BOOT_KEY];

  g[BOOT_KEY] = (async () => {
    let shuttingDown = false;

    const retryQueueWorkers = (attempt: number) => {
      const retryInMs = bullmqRetryDelay(attempt);
      const timer = setTimeout(() => {
        g.__llmhubBullmqRetry = undefined;
        if (shuttingDown) return;
        void startQueueWorkers(g).then(
          (queues) => {
            if (shuttingDown) {
              void closeQueueWorkers(g);
              return;
            }
            stopLocalTimers(g);
            setWorkerMode("bullmq");
            logger.info("worker.mode_changed", { from: "unavailable", to: "bullmq", attempt, queues });
          },
          (err) => {
            logger.warn("worker.bullmq_unavailable", {
              err: errorMessage(err),
              attempt,
              retryInMs: bullmqRetryDelay(attempt + 1),
            });
            retryQueueWorkers(attempt + 1);
          },
        );
      }, retryInMs);
      timer.unref();
      g.__llmhubBullmqRetry = timer;
    };

    if (jobsEnabled()) {
      try {
        const queues = await startQueueWorkers(g);
        setWorkerMode("bullmq");
        logger.info("worker.started", { mode: "bullmq", queues });
      } catch (err) {
        logger.warn("worker.bullmq_unavailable", {
          err: errorMessage(err),
          attempt: 0,
          retryInMs: bullmqRetryDelay(1),
        });
        setWorkerMode("unavailable");
        startLocalTimer(g);
        retryQueueWorkers(1);
      }
    } else {
      setWorkerMode("local");
      logger.info("worker.started", {
        mode: "local",
        intervalMs: WORKER_TICK_MS,
        modelSyncIntervalMs: MODEL_SYNC_TICK_MS,
      });
      startLocalTimer(g);
    }

    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("worker.shutdown", { signal });
      if (g.__llmhubBullmqRetry) {
        clearTimeout(g.__llmhubBullmqRetry);
        g.__llmhubBullmqRetry = undefined;
      }
      stopLocalTimers(g);
      await import("@/lib/gateway/catalog/catalog-tasks").then(({ stopLocalCatalogTasks }) => stopLocalCatalogTasks());
      await closeQueueWorkers(g);
      await closeQueues().catch(() => undefined);
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  })();

  try {
    await g[BOOT_KEY];
  } catch (err) {
    g[BOOT_KEY] = undefined;
    throw err;
  }
}

export function startWorker(): void {
  void bootWorker().catch((err) => {
    logger.error("worker.start_failed", { err: errorMessage(err) });
  });
}
