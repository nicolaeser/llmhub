import { PERMISSIONS } from "@/lib/auth/permissions";
import { deleteMarkup, loadMarkups, saveMarkup } from "@/lib/pricing/markups";
import { managementRoute, notFound, readBody, respond } from "@/lib/management/http";
import { serializeMarkup } from "@/lib/management/serialize";
import { markupUpdateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

async function markupById(id: string) {
  const { markups } = await loadMarkups();
  const markup = markups.find((row) => row.id === id);
  if (!markup) throw notFound("markup");
  return markup;
}

export const GET = managementRoute<{ id: string }>(PERMISSIONS.PRICING_READ, async ({ params }) => {
  return respond(serializeMarkup(await markupById(params.id)));
});

export const PATCH = managementRoute<{ id: string }>(PERMISSIONS.PRICING_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, markupUpdateSchema);
  const existing = await markupById(params.id);
  const scope = body.scope ?? existing.scope;
  const { markup } = await saveMarkup({
      id: existing.id,
      scope,
      targetId: body.target_id === undefined && scope === existing.scope ? existing.targetId : (body.target_id ?? ""),
      model: body.model === undefined ? existing.model : (body.model ?? ""),
      percent: body.percent ?? existing.percent,
      note: body.note ?? existing.note,
    });
  return respond(serializeMarkup(markup));
});

export const DELETE = managementRoute<{ id: string }>(PERMISSIONS.PRICING_MANAGE, async ({ params }) => {
  await deleteMarkup(params.id);
  return respond({ object: "markup", id: params.id, deleted: true });
});
