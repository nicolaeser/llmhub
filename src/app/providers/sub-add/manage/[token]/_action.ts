"use server";

import { runAction } from "@/lib/http/action-result";
import { loadSubAddContributions, removeSubAddContribution } from "@/lib/providers/sub-add";

export async function loadSubAddContributionsAction(...args: Parameters<typeof loadSubAddContributions>) {
  return runAction(() => loadSubAddContributions(...args));
}

export async function removeSubAddContributionAction(...args: Parameters<typeof removeSubAddContribution>) {
  return runAction(() => removeSubAddContribution(...args));
}
