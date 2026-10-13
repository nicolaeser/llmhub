import { scimHandler, scimJson } from "@/lib/auth/scim";
import { SCIM_SCHEMAS } from "@/lib/auth/scim-discovery";

export const dynamic = "force-dynamic";

export const GET = scimHandler("schemas", async () => scimJson(SCIM_SCHEMAS));
