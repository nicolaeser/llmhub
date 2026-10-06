import { createModelGroupAction, loadModelsAction } from "@/app/(app)/models/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { deploymentInputs } from "@/lib/management/deployments";
import { managementRoute, readBody, respond, respondList, unwrap } from "@/lib/management/http";
import { serializeModelAlias } from "@/lib/management/serialize";
import { modelAliasCreateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.MODELS_READ, async () => {
  const { groups } = unwrap(await loadModelsAction());
  return respondList(groups.map(serializeModelAlias));
});

export const POST = managementRoute(PERMISSIONS.MODELS_MANAGE, async ({ req }) => {
  const body = await readBody(req, modelAliasCreateSchema);
  const group = unwrap(
    await createModelGroupAction({
      alias: body.alias,
      strategy: body.strategy,
      billingMode: body.billing_mode,
      numRetries: body.num_retries,
      overflowGroup: body.overflow_group,
      fallbackGroups: body.fallback_groups,
      deployments: await deploymentInputs(body.deployments),
    }),
  );
  return respond(serializeModelAlias(group), 201);
});
