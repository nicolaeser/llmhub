import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { listedIn } from "@/lib/gateway/routing/route-pool";
import { keyScope } from "@/lib/auth/scope";
import { enabledModelChoices } from "@/lib/models/aliases";
import type { ConnectGuideData } from "@/types/api-ref";

export async function loadConnectGuide(): Promise<ConnectGuideData> {
  const session = await requirePermission(PERMISSIONS.KEYS_READ);
  const [keyCount, enabled] = await Promise.all([
    prisma.virtualKey.count({ where: keyScope(session) }),
    enabledModelChoices(),
  ]);
  const choices = enabled.filter((choice) => choice.role === "chat");
  return {
    keyCount,
    models: {
      api: choices.filter((choice) => listedIn(choice, "api")).map((choice) => choice.alias),
      subscription: choices.filter((choice) => listedIn(choice, "subscription")).map((choice) => choice.alias),
    },
    canCreateKey: hasPerm(session.permissions, PERMISSIONS.KEYS_MANAGE),
    canSeeLogs: hasPerm(session.permissions, PERMISSIONS.SPEND_READ),
  };
}
