import { PERMISSIONS } from "@/lib/auth/permissions";
import { importProviderModels } from "@/lib/providers/connections";
import { managementRoute, readBody, respond } from "@/lib/management/http";
import { serializeProvider } from "@/lib/management/serialize";
import { providerImportSchema } from "@/schemas/management";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.PROVIDERS_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, providerImportSchema);
  const imported = await importProviderModels({ id: params.id, models: body.models, strategy: body.strategy });
  return respond({
    object: "provider_import",
    provider: serializeProvider(imported.provider),
    added: imported.added,
    updated: imported.updated,
    strategy: imported.strategy,
  });
});
