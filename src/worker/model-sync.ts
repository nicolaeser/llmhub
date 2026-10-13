import "server-only";

import { runCatalogTask } from "@/lib/gateway/catalog/catalog-tasks";
import type { ModelSyncJobData, ModelSyncResult } from "@/types/jobs";

export async function runModelSync(data: ModelSyncJobData = {}): Promise<ModelSyncResult> {
  return runCatalogTask(data);
}
