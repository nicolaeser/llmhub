import type { SENTRY_DATA_COLLECTION } from "@/lib/sentry/options";
import type { WORKER_JOB_ID_TAGS } from "@/lib/sentry/worker-jobs";

export type SentryEnv = Record<string, string | undefined>;

export type SentryInitOptions = {
  dsn: string | undefined;
  enabled: boolean;
  environment: string;
  release: string | undefined;
  tracesSampleRate: number;
  dataCollection: typeof SENTRY_DATA_COLLECTION;
  beforeSend: <T extends object>(event: T) => T;
  beforeSendSpan: <T extends object>(span: T) => T;
};

export type SentryExceptionValues = {
  exception?: { values?: Array<{ value?: string }> };
};

export type WorkerJobIds = Partial<Record<keyof typeof WORKER_JOB_ID_TAGS, string>>;

export type WorkerJobFailureContext = {
  attemptsMade?: number;
  data?: unknown;
  finalAttempt: boolean;
  jobId?: string;
  queue: string;
  step?: string;
};
