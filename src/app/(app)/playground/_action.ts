"use server";

import { runAction } from "@/lib/http/action-result";
import { loadReplay } from "@/lib/gateway/request-logs/replay";
import { loadAliases } from "@/lib/models/aliases";

export async function loadReplayAction(...args: Parameters<typeof loadReplay>) {
  return runAction(() => loadReplay(...args));
}

export async function loadAliasesAction(...args: Parameters<typeof loadAliases>) {
  return runAction(() => loadAliases(...args));
}
