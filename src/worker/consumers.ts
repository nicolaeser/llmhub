import "server-only";

import { Worker, type WorkerOptions } from "bullmq";
import { logger } from "@/lib/logging/logger";
import { getQueueConnectionOptions } from "@/lib/jobs/connection";
import { QUEUE_NAMES } from "@/lib/jobs/queues";
import {
  processMaintenance,
  processModelSync,
  processWebhook,
} from "@/lib/jobs/processors";

const CONCURRENCY = 1;
const LOCK_DURATION_MS = 60_000;
const STALLED_INTERVAL_MS = 30_000;
const MAX_STALLED_COUNT = 2;

function workerOptions(): WorkerOptions {
  return {
    connection: getQueueConnectionOptions(),
    concurrency: CONCURRENCY,
    lockDuration: LOCK_DURATION_MS,
    stalledInterval: STALLED_INTERVAL_MS,
    maxStalledCount: MAX_STALLED_COUNT,
  };
}

function attachListeners(worker: Worker): void {
  worker.on("failed", (job, err) => {
    logger.error("worker.job.failed", {
      queue: worker.name,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  worker.on("stalled", (jobId) => {
    logger.warn("worker.job.stalled", { queue: worker.name, jobId });
  });
  worker.on("error", (err) => {
    logger.error("worker.error", {
      queue: worker.name,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

export function buildQueueWorkers(): Worker[] {
  const workers = [
    new Worker(QUEUE_NAMES.maintenance, processMaintenance, workerOptions()),
    new Worker(QUEUE_NAMES.models, processModelSync, workerOptions()),
    new Worker(QUEUE_NAMES.webhooks, processWebhook, workerOptions()),
  ];
  workers.forEach(attachListeners);
  return workers;
}
