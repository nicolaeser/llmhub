import { addBoostAction } from "@/app/(app)/structure/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { ApiProblem } from "@/lib/http/problem";
import { managementRoute, readBody, respond, unwrap } from "@/lib/management/http";
import { serializeBudget } from "@/lib/management/serialize";
import { budgetHolder, loadStructure } from "@/lib/management/structure";
import { budgetEntitySchema, temporaryBudgetSchema } from "@/schemas/management";

export const POST = managementRoute<{ entity_type: string; entity_id: string }>(
  PERMISSIONS.BUDGETS_MANAGE,
  async ({ req, params }) => {
    const entity = budgetEntitySchema.safeParse(params);
    if (!entity.success) {
      throw new ApiProblem("UNKNOWN_ENTITY_TYPE", "entity_type must be key, user, project, team, or org");
    }
    const { entity_type: kind, entity_id: id } = entity.data;
    const body = await readBody(req, temporaryBudgetSchema);
    const holder = budgetHolder(await loadStructure(), kind, id);
    const updated = unwrap(await addBoostAction({ kind, id, amount: body.amount, hours: body.hours }));
    return respond(serializeBudget(kind, { id, alias: holder.alias, budget: updated.budget }), 201);
  },
);
