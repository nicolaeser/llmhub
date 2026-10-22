"use server";

import { runAction } from "@/lib/http/action-result";
import {
  loadSubAddContributions,
  removeSubAddContribution,
  renewSubAddManage,
  revokeSubAddManage,
} from "@/lib/providers/sub-add";

export async function loadSubAddContributionsAction(...args: Parameters<typeof loadSubAddContributions>) {
  return runAction(() => loadSubAddContributions(...args));
}

export async function removeSubAddContributionAction(...args: Parameters<typeof removeSubAddContribution>) {
  return runAction(() => removeSubAddContribution(...args));
}

export async function renewSubAddManageAction(...args: Parameters<typeof renewSubAddManage>) {
  return runAction(() => renewSubAddManage(...args));
}

export async function revokeSubAddManageAction(...args: Parameters<typeof revokeSubAddManage>) {
  return runAction(() => revokeSubAddManage(...args));
}
