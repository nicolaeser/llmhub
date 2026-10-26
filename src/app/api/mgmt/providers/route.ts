import { PERMISSIONS } from "@/lib/auth/permissions";
import { createProvider, loadProviders } from "@/lib/providers/connections";
import { managementRoute, readBody, respond, respondList } from "@/lib/management/http";
import { serializeProvider } from "@/lib/management/serialize";
import { providerCreateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.PROVIDERS_READ, async () => {
  const { connected } = await loadProviders();
  return respondList(connected.map(serializeProvider));
});

export const POST = managementRoute(PERMISSIONS.PROVIDERS_MANAGE, async ({ req }) => {
  const body = await readBody(req, providerCreateSchema);
  const { provider } = await createProvider({
      name: body.name,
      kind: body.kind,
      baseUrl: body.base_url,
      apiKey: body.api_key,
      vertex: body.vertex,
      internal: body.internal,
      newModels: body.new_models,
    });
  return respond(serializeProvider(provider), 201);
});
