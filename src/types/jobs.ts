import type { QUEUE_NAMES } from "@/lib/jobs/queues";
import type { BOOT_KEY } from "@/worker/boot";
import type { WebhookEvent } from "@/types/gateway";

export type GlobalWithWorkerBoot = typeof globalThis & {
  [BOOT_KEY]?: Promise<void>;
  __llmhubWorkerTimer?: ReturnType<typeof setInterval>;
  __llmhubModelSyncTimer?: ReturnType<typeof setInterval>;
  __llmhubQueueWorkers?: { close: () => Promise<void> }[];
};

export type WorkerMode = "bullmq" | "local" | "unavailable";

export type HealthState = {
  mode: WorkerMode;
};

export type MaintenanceSweepResult = {
  sessions: number;
  resetTokens: number;
  loginAttempts: number;
  tempBudgets: number;
  rotatedKeys: number;
  requestLogs: number;
  requestContents: number;
  spendEvents: number;
  auditLogs: number;
  storedObjects: number;
  batches: number;
  vectorFiles: number;
  vectorStores: number;
};

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export type MaintenanceJobData = Record<string, never>;

export type ModelSyncJobData = Record<string, never>;

export type ModelSyncResult = {
  providers: number;
  changed: number;
  failed: number;
  skipped: boolean;
};

export type WebhookJobData = {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  message: string;
};
