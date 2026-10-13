"use server";

import { runAction } from "@/lib/http/action-result";
import { loadApiRef } from "@/lib/keys/api-reference";

export async function loadApiRefAction(...args: Parameters<typeof loadApiRef>) {
  return runAction(() => loadApiRef(...args));
}
