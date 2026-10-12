"use server";

import { requireAuth } from "@/lib/auth/guards";
import { runAction } from "@/lib/http/action-result";
import { getEnterprise } from "@/lib/settings/enterprise";
import { checkForUpdate } from "@/lib/updates/update-check";

export async function loadUpdateStatusAction() {
  return runAction(async () => {
    await requireAuth();
    return checkForUpdate((await getEnterprise()).update_check !== false);
  });
}
