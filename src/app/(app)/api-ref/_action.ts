"use server";

import prisma from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { OPENAPI_PATHS } from "@/lib/gateway/openapi";
import { runAction } from "@/lib/http/action-result";
import { listKeys } from "@/app/(app)/_data";

export async function loadApiRefAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.KEYS_READ);
    const [keys, models] = await Promise.all([
      listKeys(session),
      prisma.modelGroup.findMany({
        select: { alias: true },
        orderBy: { alias: "asc" },
      }),
    ]);
    const origin = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
    return {
      origin,
      paths: OPENAPI_PATHS,
      models: models.map((row) => row.alias),
      canTry: hasPerm(session.permissions, PERMISSIONS.PLAYGROUND_USE),
      keys: keys.map((key) => ({ prefix: key.key_name, alias: key.key_alias })),
    };
  });
}
