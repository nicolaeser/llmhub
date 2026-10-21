import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { readLimitSnapshot } from "@/lib/gateway/upstreams/limit-store";
import { redeemReset } from "@/lib/gateway/upstreams/reset-redeem";
import { limitsSnapshot } from "@/lib/gateway/upstreams/subscription-limits";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { refreshAccountLimits } from "@/lib/providers/limit-refresh";
import type { RedeemResponse } from "@/types/resets";

export async function redeemProviderReset(input: { id: string }): Promise<RedeemResponse> {
  const session = await requirePlatformPermission(PERMISSIONS.PROVIDERS_MANAGE);
  if (typeof input?.id !== "string" || !input.id) throw new Error("MISSING_ID");
  const row = await prisma.providerConnection.findUnique({
    where: { id: input.id },
    select: { id: true, kind: true, apiKey: true, enabled: true, login: { select: { status: true, version: true } } },
  });
  if (!row) throw new Error("NOT_FOUND");
  if (!isResetKind(row.kind)) throw new Error("RESET_UNSUPPORTED");
  if (row.login?.status !== "active") throw new Error("SIGN_IN_EXPIRED");
  const provider = { id: row.id, kind: row.kind, apiKey: row.apiKey };
  const outcome = await redeemReset(provider, { actor: session.user.id, trigger: "manual" });
  await refreshAccountLimits({ ...provider, enabled: row.enabled, loginVersion: row.login.version }).catch(
    (err: unknown) => {
      logger.warn("provider.reset_refresh_failed", { providerId: row.id, ...errorFields(err) });
    },
  );
  const item = await readLimitSnapshot(row.id);
  return { ...outcome, limits: item?.limits ?? limitsSnapshot(row.id), item };
}
