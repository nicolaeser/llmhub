import { PERMISSIONS } from "@/lib/auth/permissions";
import { discoverProvider } from "@/lib/providers/connections";
import { managementRoute, respond } from "@/lib/management/http";
import { serializeProvider } from "@/lib/management/serialize";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.PROVIDERS_MANAGE, async ({ params }) => {
  const { provider } = await discoverProvider(params.id);
  return respond(serializeProvider(provider));
});
