import "server-only";
import prisma from "@/lib/db/prisma";
import { clearCooldowns } from "@/lib/gateway/routing/provider-health";
import { clearRefreshBackoff } from "@/lib/gateway/upstreams/credentials";
import { forgetLimits } from "@/lib/gateway/upstreams/subscription-limits";

export async function reactivateAccount(providerId: string): Promise<void> {
  const routes = await prisma.deployment.findMany({ where: { providerId }, select: { id: true } });
  await clearCooldowns(routes.map((route) => route.id));
  await forgetLimits(providerId);
  await clearRefreshBackoff(providerId);
}
