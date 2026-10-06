import { saveBudgetAlertsAction } from "@/app/(app)/structure/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readBody, respond, unwrap } from "@/lib/management/http";
import { budgetAlertsSchema } from "@/schemas/management";

export const PUT = managementRoute(PERMISSIONS.BUDGETS_MANAGE, async ({ req }) => {
  const body = await readBody(req, budgetAlertsSchema);
  const saved = unwrap(await saveBudgetAlertsAction(body.thresholds));
  return respond({ object: "budget_alerts", thresholds: saved.thresholds });
});
