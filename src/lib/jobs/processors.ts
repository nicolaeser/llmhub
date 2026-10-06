import "server-only";

import type { Job } from "bullmq";
import { deliverWebhook } from "@/lib/gateway/alerts";
import { runMaintenanceSweep } from "@/worker/jobs";
import { runModelSync } from "@/worker/model-sync";
import type { WebhookJobData } from "@/types/jobs";

export async function processMaintenance(): Promise<void> {
  await runMaintenanceSweep();
}

export async function processModelSync(): Promise<void> {
  await runModelSync();
}

export async function processWebhook(job: Job<WebhookJobData>): Promise<void> {
  await deliverWebhook(job.data, job.attemptsMade + 1);
}
