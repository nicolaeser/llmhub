import "server-only";

import { DelayedError, type Job } from "bullmq";
import * as Sentry from "@sentry/node";
import type { WorkerJobFailureContext, WorkerJobIds } from "@/types/sentry";

export const WORKER_JOB_ID_TAGS = {
  id: "llmhub.alert_id",
  webhookId: "llmhub.webhook_id",
  providerId: "llmhub.provider_id",
  task: "llmhub.catalog_task",
} as const;

export function workerJobIds(data: unknown): WorkerJobIds {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const record = data as Record<string, unknown>;
  const ids: WorkerJobIds = {};
  for (const key of Object.keys(WORKER_JOB_ID_TAGS) as Array<keyof WorkerJobIds>) {
    const value = record[key];
    if (typeof value === "string" && value) ids[key] = value;
  }
  return ids;
}

export function reportWorkerJobFailure(
  error: unknown,
  context: WorkerJobFailureContext,
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  Sentry.withScope((scope) => {
    scope.setTag("llmhub.surface", "worker");
    scope.setTag("llmhub.queue", context.queue);
    scope.setTag("llmhub.final_attempt", context.finalAttempt ? "true" : "false");
    if (context.step) scope.setTag("llmhub.step", context.step);
    if (context.jobId) scope.setTag("llmhub.job_id", context.jobId);
    if (typeof context.attemptsMade === "number") {
      scope.setExtra("llmhub.attempts_made", context.attemptsMade);
    }
    const ids = workerJobIds(context.data);
    for (const [key, tag] of Object.entries(WORKER_JOB_ID_TAGS)) {
      const value = ids[key as keyof WorkerJobIds];
      if (value) scope.setTag(tag, value);
    }
    scope.setFingerprint(["worker", context.queue, context.step ?? "job", err.name]);
    Sentry.captureException(err);
  });
}

export function wrapWorkerProcessor<T>(
  queue: string,
  processor: (job: Job<T>, token?: string) => Promise<unknown>,
): (job: Job<T>, token?: string) => Promise<unknown> {
  return async (job, token) => {
    try {
      return await Sentry.startSpan(
        { name: `queue.${queue}`, op: "queue.process" },
        () => processor(job, token),
      );
    } catch (error) {
      if (error instanceof DelayedError) throw error;
      const attempts = Math.max(1, job.opts.attempts ?? 1);
      reportWorkerJobFailure(error, {
        queue,
        jobId: typeof job.id === "string" ? job.id : undefined,
        attemptsMade: job.attemptsMade,
        finalAttempt: job.attemptsMade + 1 >= attempts,
        data: job.data,
      });
      throw error;
    }
  };
}
