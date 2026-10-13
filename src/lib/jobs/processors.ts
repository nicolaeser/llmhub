import "server-only";

import { DelayedError, type Job } from "bullmq";
import { CATALOG_BUSY_DELAY_MS } from "@/lib/gateway/catalog/catalog-tasks";
import { deliverWebhook } from "@/lib/alerts/notify";
import { runMaintenanceSweep } from "@/worker/jobs";
import { runModelSync } from "@/worker/model-sync";
import type { ModelSyncJobData, WebhookJobData } from "@/types/jobs";

export async function processMaintenance(): Promise<void> {
  await runMaintenanceSweep();
}

export async function processModelSync(job: Job<ModelSyncJobData>, token?: string): Promise<void> {
  try {
    await runModelSync(job.data);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "CATALOG_BUSY") throw err;
    await job.moveToDelayed(Date.now() + CATALOG_BUSY_DELAY_MS, token);
    throw new DelayedError();
  }
}

export async function processWebhook(job: Job<WebhookJobData>): Promise<void> {
  await deliverWebhook(job.data, job.attemptsMade + 1);
}
