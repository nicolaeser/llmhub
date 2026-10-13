import { scimHandler, scimJson } from "@/lib/auth/scim";
import { SCIM_RESOURCE_TYPES } from "@/lib/auth/scim-discovery";

export const dynamic = "force-dynamic";

export const GET = scimHandler("resource_types", async () => scimJson(SCIM_RESOURCE_TYPES));
