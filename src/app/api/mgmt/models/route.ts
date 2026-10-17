import { PERMISSIONS } from "@/lib/auth/permissions";
import { createModelGroup, loadModels } from "@/lib/models/groups";
import { deploymentInputs, priceWindowInputs } from "@/lib/management/deployments";
import { managementRoute, readBody, respond, respondList } from "@/lib/management/http";
import { serializeModelAlias } from "@/lib/management/serialize";
import { modelAliasCreateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.MODELS_READ, async () => {
  const { groups } = await loadModels();
  return respondList(groups.map(serializeModelAlias));
});

export const POST = managementRoute(PERMISSIONS.MODELS_MANAGE, async ({ req }) => {
  const body = await readBody(req, modelAliasCreateSchema);
  const group = await createModelGroup({
      alias: body.alias,
      enabled: body.enabled,
      vendor: body.vendor,
      displayName: body.display_name,
      autoRoutes: body.auto_routes,
      variants: body.variants,
      strategy: body.strategy,
      billingMode: body.billing_mode,
      priceInput: body.price_input_per_1k,
      priceOutput: body.price_output_per_1k,
      priceTimeZone: body.price_time_zone,
      priceWindows: priceWindowInputs(body.price_schedule),
      numRetries: body.num_retries,
      overflowGroup: body.overflow_group,
      fallbackGroups: body.fallback_groups,
      deployments: await deploymentInputs(body.deployments),
    });
  return respond(serializeModelAlias(group), 201);
});
