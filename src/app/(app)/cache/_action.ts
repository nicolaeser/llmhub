"use server";

import { runAction } from "@/lib/http/action-result";
import { loadCache, loadCacheStats, saveCache } from "@/lib/settings/caching";

export async function loadCacheAction(...args: Parameters<typeof loadCache>) {
  return runAction(() => loadCache(...args));
}

export async function loadCacheStatsAction(...args: Parameters<typeof loadCacheStats>) {
  return runAction(() => loadCacheStats(...args));
}

export async function saveCacheAction(...args: Parameters<typeof saveCache>) {
  return runAction(() => saveCache(...args));
}
