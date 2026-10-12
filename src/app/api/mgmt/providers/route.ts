import { createProviderAction, loadProvidersAction } from "@/app/(app)/providers/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readBody, respond, respondList, unwrap } from "@/lib/management/http";
import { serializeProvider } from "@/lib/management/serialize";
import { providerCreateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.PROVIDERS_READ, async () => {
  const { connected } = unwrap(await loadProvidersAction());
  return respondList(connected.map(serializeProvider));
});

export const POST = managementRoute(PERMISSIONS.PROVIDERS_MANAGE, async ({ req }) => {
  const body = await readBody(req, providerCreateSchema);
  const { provider } = unwrap(
    await createProviderAction({
      name: body.name,
      kind: body.kind,
      baseUrl: body.base_url,
      apiKey: body.api_key,
    }),
  );
  return respond(serializeProvider(provider), 201);
});
