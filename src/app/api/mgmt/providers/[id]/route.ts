import { PERMISSIONS } from "@/lib/auth/permissions";
import { deleteProvider, loadProviders, updateProvider } from "@/lib/providers/connections";
import { managementRoute, notFound, readBody, respond } from "@/lib/management/http";
import { serializeProvider } from "@/lib/management/serialize";
import { providerUpdateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute<{ id: string }>(PERMISSIONS.PROVIDERS_READ, async ({ params }) => {
  const provider = (await loadProviders()).connected.find((row) => row.id === params.id);
  if (!provider) throw notFound("provider");
  return respond(serializeProvider(provider));
});

export const PATCH = managementRoute<{ id: string }>(PERMISSIONS.PROVIDERS_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, providerUpdateSchema);
  const { provider } = await updateProvider({
      id: params.id,
      name: body.name ?? "",
      baseUrl: body.base_url ?? "",
      apiKey: body.api_key ?? "",
      enabled: body.enabled,
      vertex: body.vertex,
      internal: body.internal,
    });
  return respond(serializeProvider(provider));
});

export const DELETE = managementRoute<{ id: string }>(PERMISSIONS.PROVIDERS_MANAGE, async ({ params }) => {
  const deleted = await deleteProvider(params.id);
  return respond({ object: "provider", id: deleted.id, deleted: true });
});
