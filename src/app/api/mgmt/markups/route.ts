import { PERMISSIONS } from "@/lib/auth/permissions";
import { loadMarkups, saveMarkup } from "@/lib/pricing/markups";
import { managementRoute, readBody, respond, respondList } from "@/lib/management/http";
import { serializeMarkup } from "@/lib/management/serialize";
import { markupCreateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.PRICING_READ, async () => {
  const { markups } = await loadMarkups();
  return respondList(markups.map(serializeMarkup));
});

export const POST = managementRoute(PERMISSIONS.PRICING_MANAGE, async ({ req }) => {
  const body = await readBody(req, markupCreateSchema);
  const { markup } = await saveMarkup({
      scope: body.scope,
      targetId: body.target_id ?? "",
      model: body.model ?? "",
      percent: body.percent,
      note: body.note,
    });
  return respond(serializeMarkup(markup), 201);
});
