import "server-only";

import prisma from "@/lib/db/prisma";
import { refreshProviderModels } from "@/lib/gateway/discovery";
import { logger } from "@/lib/logging/logger";
import type { ModelSyncResult } from "@/types/jobs";

export async function runModelSync(): Promise<ModelSyncResult> {
  const rows = await prisma.providerConnection.findMany({ orderBy: { createdAt: "asc" } });
  const result: ModelSyncResult = { providers: rows.length, changed: 0, failed: 0 };
  for (const row of rows) {
    try {
      const { diff } = await refreshProviderModels(row, "worker");
      if (diff.changed) result.changed += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn("model_sync.provider_failed", {
        provider: row.id,
        kind: row.kind,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
