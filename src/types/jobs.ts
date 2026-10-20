import type { QUEUE_NAMES } from "@/lib/jobs/queues";
import type { BOOT_KEY } from "@/worker/boot";
import type { WebhookEvent } from "@/types/alerts";

export type GlobalWithWorkerBoot = typeof globalThis & {
  [BOOT_KEY]?: Promise<void>;
  __llmhubWorkerTimer?: ReturnType<typeof setInterval>;
  __llmhubModelSyncTimer?: ReturnType<typeof setInterval>;
  __llmhubCatalogTimers?: Map<string, ReturnType<typeof setTimeout>>;
  __llmhubBullmqRetry?: ReturnType<typeof setTimeout>;
  __llmhubQueueWorkers?: { close: () => Promise<void> }[];
};

export type WorkerMode = "bullmq" | "local" | "unavailable";

export type WorkerHealth = {
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
  reports: number;
  signIns: number;
  supersededLogins: number;
  limits: number;
  resets: number;
};

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export type MaintenanceJobData = Record<string, never>;

export type CatalogTask = "refresh" | "provider" | "rebuild";

export type ModelSyncJobData = {
  task?: CatalogTask;
  providerId?: string;
};

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

export type SpendResetRow = {
  id: string;
  budgetDuration: string;
  spendResetAt: Date | null;
  createdAt: Date;
};
