import { loadMarkupsAction, saveMarkupAction } from "@/app/(app)/markups/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readBody, respond, respondList, unwrap } from "@/lib/management/http";
import { serializeMarkup } from "@/lib/management/serialize";
import { markupCreateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.PRICING_READ, async () => {
  const { markups } = unwrap(await loadMarkupsAction());
  return respondList(markups.map(serializeMarkup));
});

export const POST = managementRoute(PERMISSIONS.PRICING_MANAGE, async ({ req }) => {
  const body = await readBody(req, markupCreateSchema);
  const { markup } = unwrap(
    await saveMarkupAction({
      scope: body.scope,
      targetId: body.target_id ?? "",
      model: body.model ?? "",
      percent: body.percent,
      note: body.note,
    }),
  );
  return respond(serializeMarkup(markup), 201);
});
