import { discoverProviderAction } from "@/app/(app)/providers/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, respond, unwrap } from "@/lib/management/http";
import { serializeProvider } from "@/lib/management/serialize";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.PROVIDERS_MANAGE, async ({ params }) => {
  const { provider } = unwrap(await discoverProviderAction(params.id));
  return respond(serializeProvider(provider));
});
