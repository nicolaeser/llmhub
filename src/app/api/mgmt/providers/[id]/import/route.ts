import { importProviderModelsAction } from "@/app/(app)/providers/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readBody, respond, unwrap } from "@/lib/management/http";
import { serializeProvider } from "@/lib/management/serialize";
import { providerImportSchema } from "@/schemas/management";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.PROVIDERS_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, providerImportSchema);
  const imported = unwrap(
    await importProviderModelsAction({ id: params.id, models: body.models, strategy: body.strategy }),
  );
  return respond({
    object: "provider_import",
    provider: serializeProvider(imported.provider),
    added: imported.added,
    updated: imported.updated,
    strategy: imported.strategy,
  });
});
