import { PERMISSIONS } from "@/lib/auth/permissions";
import { setBudget } from "@/lib/tenancy/budgets";
import { ApiProblem } from "@/lib/http/problem";
import { managementRoute, readBody, respond } from "@/lib/management/http";
import { serializeBudget } from "@/lib/management/serialize";
import { budgetHolder } from "@/lib/management/structure";
import { loadStructure } from "@/lib/tenancy/structure";
import { budgetEntitySchema, budgetUpdateSchema } from "@/schemas/management";

export const PUT = managementRoute<{ entity_type: string; entity_id: string }>(
  PERMISSIONS.BUDGETS_MANAGE,
  async ({ req, params }) => {
    const entity = budgetEntitySchema.safeParse(params);
    if (!entity.success) {
      throw new ApiProblem("UNKNOWN_ENTITY_TYPE", "entity_type must be key, user, member, project, team, or org");
    }
    const { entity_type: kind, entity_id: id } = entity.data;
    const body = await readBody(req, budgetUpdateSchema);
    const holder = budgetHolder(await loadStructure(), kind, id);
    const updated = await setBudget({
        kind,
        id,
        maxBudget: body.max_budget,
        budgetDuration: body.budget_duration ?? holder.budget.budgetDuration,
      });
    return respond(serializeBudget(kind, { id, alias: holder.alias, budget: updated.budget }));
  },
);
