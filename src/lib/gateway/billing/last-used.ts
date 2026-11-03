import "server-only";
import prisma from "@/lib/db/prisma";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type { Principal } from "@/types/gateway";
import type { Deployment } from "@/types/routing";

export const LAST_USED_WRITE_MS = 60_000;
const MAX_TRACKED = 10_000;

const writtenAt = new Map<string, number>();

function claimWrite(id: string, now: number): boolean {
  const last = writtenAt.get(id);
  if (last !== undefined && now - last < LAST_USED_WRITE_MS) return false;
  if (writtenAt.size >= MAX_TRACKED) writtenAt.clear();
  writtenAt.set(id, now);
  return true;
}

function staleSince(now: number) {
  return { OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now - LAST_USED_WRITE_MS) } }] };
}

export async function markUsed(
  principal: Principal,
  deployment: Deployment | null | undefined,
  now = Date.now(),
): Promise<void> {
  if (principal.system) return;
  const at = new Date(now);
  const keyId = principal.key?.token_id ?? "";
  const providerId = deployment && isSignInKind(deployment.kind) ? deployment.provider_id : "";
  const writes: Promise<unknown>[] = [];
  if (keyId && claimWrite(`key:${keyId}`, now)) {
    writes.push(prisma.virtualKey.updateMany({ where: { id: keyId, ...staleSince(now) }, data: { lastUsedAt: at } }));
  }
  if (providerId && claimWrite(`login:${providerId}`, now)) {
    writes.push(
      prisma.providerLogin.updateMany({ where: { providerId, ...staleSince(now) }, data: { lastUsedAt: at } }),
    );
  }
  try {
    await Promise.all(writes);
  } catch (err) {
    logger.warn("billing.last_used_failed", { keyId, providerId, ...errorFields(err) });
  }
}
