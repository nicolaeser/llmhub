import { PERMISSIONS } from "@/lib/auth/permissions";
import { saveBudgetAlerts } from "@/lib/tenancy/budgets";
import { managementRoute, readBody, respond } from "@/lib/management/http";
import { budgetAlertsSchema } from "@/schemas/management";

export const PUT = managementRoute(PERMISSIONS.BUDGETS_MANAGE, async ({ req }) => {
  const body = await readBody(req, budgetAlertsSchema);
  const saved = await saveBudgetAlerts(body.thresholds);
  return respond({ object: "budget_alerts", thresholds: saved.thresholds });
});
