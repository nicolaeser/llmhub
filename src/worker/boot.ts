import "server-only";

import { logger } from "@/lib/logging/logger";
import { jobsEnabled } from "@/lib/jobs/connection";
import { closeQueues } from "@/lib/jobs/queues";
import { setWorkerMode } from "./health";
import type { GlobalWithWorkerBoot } from "@/types/jobs";

const WORKER_TICK_MS = 60_000;
const MODEL_SYNC_TICK_MS = 3_600_000;

export const BOOT_KEY = "__llmhubWorkerBoot";

function startLocalModelSync(g: GlobalWithWorkerBoot): void {
  if (g.__llmhubModelSyncTimer) return;
  const sync = () =>
    import("./model-sync")
      .then(({ runModelSync }) => runModelSync())
      .catch((err) => {
        logger.error("worker.model_sync_failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
  void sync();
  const timer = setInterval(sync, MODEL_SYNC_TICK_MS);
  timer.unref();
  g.__llmhubModelSyncTimer = timer;
}

function startLocalTimer(g: GlobalWithWorkerBoot): void {
  startLocalModelSync(g);
  if (g.__llmhubWorkerTimer) return;
  const tick = () =>
    import("./jobs")
      .then(({ runMaintenanceSweep }) => runMaintenanceSweep())
      .then((result) => {
        if (Object.values(result).some((n) => n > 0)) {
          logger.info("worker.tick", result);
        }
      })
      .catch((err) => {
        logger.error("worker.tick_failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
  void tick();
  const timer = setInterval(tick, WORKER_TICK_MS);
  timer.unref();
  g.__llmhubWorkerTimer = timer;
}

async function bootWorker(): Promise<void> {
  const g = globalThis as GlobalWithWorkerBoot;
  if (g[BOOT_KEY]) return g[BOOT_KEY];

  g[BOOT_KEY] = (async () => {
    if (jobsEnabled()) {
      try {
        const { buildQueueWorkers } = await import("./consumers");
        const { registerWorkerSchedules } = await import("./schedules");
        const workers = buildQueueWorkers();
        g.__llmhubQueueWorkers = workers;
        await registerWorkerSchedules();
        setWorkerMode("bullmq");
        logger.info("worker.started", {
          mode: "bullmq",
          queues: workers.map((worker) => worker.name),
        });
      } catch (err) {
        logger.warn("worker.bullmq_unavailable", {
          err: err instanceof Error ? err.message : String(err),
        });
        setWorkerMode("unavailable");
        startLocalTimer(g);
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

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("worker.shutdown", { signal });
      if (g.__llmhubWorkerTimer) {
        clearInterval(g.__llmhubWorkerTimer);
        g.__llmhubWorkerTimer = undefined;
      }
      if (g.__llmhubModelSyncTimer) {
        clearInterval(g.__llmhubModelSyncTimer);
        g.__llmhubModelSyncTimer = undefined;
      }
      await Promise.all(
        (g.__llmhubQueueWorkers ?? []).map((worker) => worker.close()),
      );
      g.__llmhubQueueWorkers = undefined;
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
    logger.error("worker.start_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  });
}
