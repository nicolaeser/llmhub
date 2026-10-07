import "server-only";

import { refreshCatalog } from "@/lib/gateway/catalog-sync";
import type { ModelSyncResult } from "@/types/jobs";

export async function runModelSync(): Promise<ModelSyncResult> {
  const { state, skipped, changed } = await refreshCatalog({ actor: "worker", force: false });
  if (skipped || !state) return { providers: 0, changed: 0, failed: 0, skipped: true };
  return { providers: state.providers, changed, failed: state.failed.length, skipped: false };
}
