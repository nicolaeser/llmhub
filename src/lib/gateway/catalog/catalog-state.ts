import "server-only";
import prisma from "@/lib/db/prisma";
import { acquireLease, releaseLease } from "@/lib/jobs/lease";
import { asRecord, asNumber, asString } from "@/lib/gateway/core";
import { jevFingerprint } from "@/lib/gateway/catalog/jev";
import type { CatalogState, JevSettings } from "@/types/model-catalog";

export const CATALOG_REFRESH_MS = 7_200_000;

const CATALOG_STATE = "model_catalog_state";
const CATALOG_LOCK = "model_catalog_lock";
const LOCK_TTL_MS = 600_000;

function parseState(raw: unknown): CatalogState | null {
  const rec = asRecord(raw);
  const refreshedAt = asString(rec?.refreshedAt);
  if (!rec || !refreshedAt || Number.isNaN(Date.parse(refreshedAt))) return null;
  const jev = asRecord(rec.jev) ?? {};
  return {
    refreshedAt,
    durationMs: asNumber(rec.durationMs),
    providers: asNumber(rec.providers),
    failed: (Array.isArray(rec.failed) ? rec.failed : []).flatMap((item) => {
      const row = asRecord(item);
      return row ? [{ providerId: asString(row.providerId), name: asString(row.name), code: asString(row.code) }] : [];
    }),
    entries: asNumber(rec.entries),
    autoRouted: asNumber(rec.autoRouted),
    jev: {
      configured: jev.configured === true,
      asked: asNumber(jev.asked),
      matched: asNumber(jev.matched),
      pending: asNumber(jev.pending),
      cost: asNumber(jev.cost),
      error: asString(jev.error),
      settings: asString(jev.settings),
    },
  };
}

export async function getCatalogState(): Promise<CatalogState | null> {
  const row = await prisma.setting.findUnique({ where: { key: CATALOG_STATE } });
  if (!row) return null;
  try {
    return parseState(JSON.parse(row.value));
  } catch {
    return null;
  }
}

export async function saveState(state: CatalogState): Promise<void> {
  const value = JSON.stringify(state);
  await prisma.setting.upsert({ where: { key: CATALOG_STATE }, update: { value }, create: { key: CATALOG_STATE, value } });
}

export async function acquireLock(): Promise<string | null> {
  return acquireLease(CATALOG_LOCK, LOCK_TTL_MS);
}

export async function releaseLock(value: string): Promise<void> {
  await releaseLease(CATALOG_LOCK, value);
}

export function jevErrorOutdated(state: CatalogState | null, settings: JevSettings | undefined): boolean {
  return Boolean(state?.jev.error) && state?.jev.settings !== jevFingerprint(settings);
}
