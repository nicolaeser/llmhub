import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { redeemReset, withResetDetails } from "@/lib/gateway/upstreams/reset-redeem";
import { limitsSnapshot, subscriptionLimits } from "@/lib/gateway/upstreams/subscription-limits";
import type { RedeemResponse } from "@/types/resets";

export async function redeemProviderReset(input: { id: string }): Promise<RedeemResponse> {
  const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
  if (typeof input?.id !== "string" || !input.id) throw new Error("MISSING_ID");
  const row = await prisma.providerConnection.findUnique({
    where: { id: input.id },
    select: { id: true, kind: true, apiKey: true, login: { select: { status: true } } },
  });
  if (!row) throw new Error("NOT_FOUND");
  if (!isResetKind(row.kind)) throw new Error("RESET_UNSUPPORTED");
  if (row.login?.status !== "active") throw new Error("SIGN_IN_EXPIRED");
  const provider = { id: row.id, kind: row.kind, apiKey: row.apiKey };
  const outcome = await redeemReset(provider, { actor: session.user.id, trigger: "manual" });
  const limits = await subscriptionLimits(provider, { force: true }).catch(() => limitsSnapshot(provider.id));
  return { ...outcome, limits: await withResetDetails(provider, limits) };
}
