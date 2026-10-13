import { scimHandler, scimJson } from "@/lib/auth/scim";
import { SCIM_SERVICE_PROVIDER_CONFIG } from "@/lib/auth/scim-discovery";

export const dynamic = "force-dynamic";

export const GET = scimHandler("service_provider_config", async () => scimJson(SCIM_SERVICE_PROVIDER_CONFIG));
