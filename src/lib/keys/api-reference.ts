import "server-only";

import { apiModelChoices } from "@/lib/models/aliases";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { OPENAPI_PATHS } from "@/lib/gateway/endpoints/openapi";
import { listKeys } from "@/lib/keys/view";

export async function loadApiRef() {
  const session = await requirePermission(PERMISSIONS.KEYS_READ);
  const [keys, models] = await Promise.all([
    listKeys(session),
    apiModelChoices(),
  ]);
  return {
    paths: OPENAPI_PATHS,
    models: models.map((choice) => choice.alias),
    canTry: hasPerm(session.permissions, PERMISSIONS.PLAYGROUND_USE),
    keys: keys.map((key) => ({ prefix: key.key_name, alias: key.key_alias })),
  };
}
