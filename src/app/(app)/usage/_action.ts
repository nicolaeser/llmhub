"use server";

import { runAction } from "@/lib/http/action-result";
import { loadUsage } from "@/lib/usage/dashboard";

export async function loadUsageAction(...args: Parameters<typeof loadUsage>) {
  return runAction(() => loadUsage(...args));
}
