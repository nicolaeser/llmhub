import "server-only";

import { QUEUE_NAMES, getMaintenanceQueue, getModelsQueue } from "@/lib/jobs/queues";

const MAINTENANCE_INTERVAL_MS = 60_000;
const MODEL_SYNC_INTERVAL_MS = 7_200_000;
const MODEL_SYNC_BOOT_DEDUP_MS = 600_000;

export async function registerWorkerSchedules(): Promise<void> {
  await getMaintenanceQueue().upsertJobScheduler(
    QUEUE_NAMES.maintenance,
    { every: MAINTENANCE_INTERVAL_MS },
    { name: QUEUE_NAMES.maintenance, data: {} },
  );
  const models = getModelsQueue();
  await models.upsertJobScheduler(
    QUEUE_NAMES.models,
    { every: MODEL_SYNC_INTERVAL_MS },
    { name: QUEUE_NAMES.models, data: {} },
  );
  await models.add(
    QUEUE_NAMES.models,
    {},
    { deduplication: { id: "model-sync-boot", ttl: MODEL_SYNC_BOOT_DEDUP_MS } },
  );
}
