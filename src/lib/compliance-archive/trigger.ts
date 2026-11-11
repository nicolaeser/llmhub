import "server-only";

import { enqueueArchiveRun } from "@/lib/jobs/queues";
import { runArchiveInProcess } from "@/worker/archive";
import { getWorkerMode } from "@/worker/health";

export async function requestArchiveRun(): Promise<void> {
  if (getWorkerMode() === "bullmq") {
    await enqueueArchiveRun();
    return;
  }
  void runArchiveInProcess();
}
