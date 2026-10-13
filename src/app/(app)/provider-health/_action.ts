"use server";

import { runAction } from "@/lib/http/action-result";
import { loadProviderHealth } from "@/lib/gateway/routing/health-report";

export async function loadProviderHealthAction(...args: Parameters<typeof loadProviderHealth>) {
  return runAction(() => loadProviderHealth(...args));
}
