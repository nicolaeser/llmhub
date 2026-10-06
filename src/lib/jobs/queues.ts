import "server-only";

import { Queue, type DefaultJobOptions } from "bullmq";
import { getQueueConnectionOptions } from "./connection";
import { logger } from "@/lib/logging/logger";
import type {
  QueueName,
  MaintenanceJobData,
  ModelSyncJobData,
  WebhookJobData,
} from "@/types/jobs";

export const QUEUE_NAMES = {
  maintenance: "llmhub-maintenance",
  models: "llmhub-models",
  webhooks: "llmhub-webhooks",
} as const;
const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 604_800 },
};

const queues = new Map<QueueName, Queue>();

function getQueue<TData>(name: QueueName): Queue<TData> {
  const existing = queues.get(name);
  if (existing) return existing as Queue<TData>;
  const queue = new Queue<TData>(name, {
    connection: getQueueConnectionOptions(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  queue.on("error", (err) => {
    logger.error("queue.error", {
      queue: name,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  queues.set(name, queue as Queue);
  return queue;
}

export function getMaintenanceQueue(): Queue<MaintenanceJobData> {
  return getQueue<MaintenanceJobData>(QUEUE_NAMES.maintenance);
}

export function getModelsQueue(): Queue<ModelSyncJobData> {
  return getQueue<ModelSyncJobData>(QUEUE_NAMES.models);
}

function getWebhooksQueue(): Queue<WebhookJobData> {
  return getQueue<WebhookJobData>(QUEUE_NAMES.webhooks);
}

export function enqueueWebhook(data: WebhookJobData) {
  return getWebhooksQueue().add(QUEUE_NAMES.webhooks, data, {
    attempts: 8,
    backoff: { type: "exponential", delay: 10_000 },
    jobId: `${data.id}-${data.webhookId}`,
  });
}

export async function closeQueues(): Promise<void> {
  const open = [...queues.values()];
  queues.clear();
  await Promise.all(open.map((queue) => queue.close()));
}
