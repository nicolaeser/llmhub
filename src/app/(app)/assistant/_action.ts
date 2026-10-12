"use server";

import { runAction } from "@/lib/http/action-result";
import { loadAssistant } from "@/lib/assistant/console";

export async function loadAssistantAction(...args: Parameters<typeof loadAssistant>) {
  return runAction(() => loadAssistant(...args));
}
