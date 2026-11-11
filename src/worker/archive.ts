import "server-only";

import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { QUEUE_NAMES } from "@/lib/jobs/queues";
import { reportWorkerJobFailure } from "@/lib/sentry/worker-jobs";
import type { GlobalWithWorkerBoot } from "@/types/jobs";

async function runArchiveOnce(): Promise<void> {
  const { logArchiveTick, runComplianceArchive } = await import("@/lib/compliance-archive/runner");
  logArchiveTick(await runComplianceArchive());
}

export function runArchiveInProcess(): Promise<void> {
  const g = globalThis as GlobalWithWorkerBoot;
  if (g.__llmhubArchiveRun) return g.__llmhubArchiveRun;
  const run = runArchiveOnce()
    .catch((err) => {
      logger.error("compliance_archive.tick_failed", errorFields(err));
      reportWorkerJobFailure(err, { queue: QUEUE_NAMES.archive, finalAttempt: true });
    })
    .finally(() => {
      g.__llmhubArchiveRun = undefined;
    });
  g.__llmhubArchiveRun = run;
  return run;
}
