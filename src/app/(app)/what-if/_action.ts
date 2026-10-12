"use server";

import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { spendScope } from "@/lib/auth/scope";
import { loadWhatIf } from "@/lib/gateway/what-if-data";
import { actionFail, runAction } from "@/lib/http/action-result";
import { whatIfQuerySchema } from "@/schemas/what-if";

export async function loadWhatIfAction(raw: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SPEND_READ);
    const parsed = whatIfQuerySchema.safeParse(raw);
    if (!parsed.success) return actionFail("VALIDATION");
    return loadWhatIf(spendScope(session), parsed.data.model);
  });
}
