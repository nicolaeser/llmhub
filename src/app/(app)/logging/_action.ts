"use server";

import { runAction } from "@/lib/http/action-result";
import { loadLogging, saveLogging } from "@/lib/settings/logging-alerts";

export async function loadLoggingAction(...args: Parameters<typeof loadLogging>) {
  return runAction(() => loadLogging(...args));
}

export async function saveLoggingAction(...args: Parameters<typeof saveLogging>) {
  return runAction(() => saveLogging(...args));
}
