import {
  deleteModelGroupAction,
  loadModelsAction,
  updateModelGroupAction,
} from "@/app/(app)/models/_action";
import prisma from "@/lib/db/prisma";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { asStringArray } from "@/lib/gateway/core";
import { modelAlias } from "@/lib/gateway/model-alias";
import { deploymentInputs, priceWindowInputs } from "@/lib/management/deployments";
import { managementRoute, notFound, readBody, respond, unwrap } from "@/lib/management/http";
import { serializeModelAlias } from "@/lib/management/serialize";
import { modelAliasUpdateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute<{ alias: string }>(PERMISSIONS.MODELS_READ, async ({ params }) => {
  const alias = modelAlias(params.alias);
  const group = unwrap(await loadModelsAction()).groups.find((row) => row.alias === alias);
  if (!group) throw notFound("model alias");
  return respond(serializeModelAlias(group));
});

export const PATCH = managementRoute<{ alias: string }>(PERMISSIONS.MODELS_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, modelAliasUpdateSchema);
  const existing = await prisma.modelGroup.findUnique({ where: { alias: modelAlias(params.alias) } });
  if (!existing) throw notFound("model alias");
  const group = unwrap(
    await updateModelGroupAction({
      alias: existing.alias,
      enabled: body.enabled,
      vendor: body.vendor,
      displayName: body.display_name,
      autoRoutes: body.auto_routes,
      strategy: body.strategy ?? existing.strategy,
      billingMode: body.billing_mode ?? existing.billingMode,
      priceInput: body.price_input_per_1k,
      priceOutput: body.price_output_per_1k,
      priceTimeZone: body.price_time_zone,
      priceWindows: priceWindowInputs(body.price_schedule),
      numRetries: body.num_retries ?? existing.numRetries,
      overflowGroup: body.overflow_group ?? existing.overflowGroup,
      fallbackGroups: body.fallback_groups ?? asStringArray(existing.fallbackGroups),
      deployments: body.deployments ? await deploymentInputs(body.deployments) : undefined,
    }),
  );
  return respond(serializeModelAlias(group));
});

export const DELETE = managementRoute<{ alias: string }>(PERMISSIONS.MODELS_MANAGE, async ({ params }) => {
  const deleted = unwrap(await deleteModelGroupAction(params.alias));
  return respond({ object: "model_alias", alias: deleted.alias, deleted: true });
});
