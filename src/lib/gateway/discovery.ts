import "server-only";
import prisma from "@/lib/db/prisma";
import { isPrismaCode } from "@/lib/auth/errors";
import { open } from "@/lib/crypto";
import { env } from "@/lib/env";
import { fireAlert } from "@/lib/gateway/alerts";
import { PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { discoveredOf, parsePricing } from "@/lib/gateway/provider-prices";
import { logger } from "@/lib/logging/logger";
import type { DiscoveredDiff, DiscoveredModel, RepricedModel } from "@/types/gateway";
import type { ProviderSyncRecord } from "@/types/providers";

const ALERT_LIST_LIMIT = 10;

const UNCHANGED: DiscoveredDiff = { added: [], removed: [], repriced: [], changed: false };

function modelsUrl(kind: string, base: string): string {
  let b = base.trim().replace(/\/$/, "");
  if (!b) {
    b = (PROVIDER_CATALOG.find((k) => k.kind === kind)?.default_base_url ?? "").replace(/\/$/, "");
  }
  if (!b) throw new Error("BASE_URL_REQUIRED");
  if (b.endsWith("/models")) return b;
  if (b.endsWith("/v1")) return `${b}/models`;
  return `${b}/v1/models`;
}

export async function fetchProviderModels(
  kind: string,
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const url = modelsUrl(kind, baseUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    if (kind === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }
  if (kind === "openrouter" || kind === "openrouter_eu") {
    headers["HTTP-Referer"] = env.NEXT_PUBLIC_APP_URL;
    headers["X-Title"] = "LLM Hub";
  }
  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new Error("UPSTREAM_FAILED");
  });
  const json = (await resp.json().catch(() => ({}))) as unknown;
  if (!resp.ok) {
    throw new Error(resp.status === 401 || resp.status === 403 ? "UPSTREAM_AUTH" : "UPSTREAM_FAILED");
  }
  const rec = asRecord(json);
  const list = rec && (Array.isArray(rec.data) ? rec.data : rec.models);
  const data = Array.isArray(list) ? list : [];
  const out: DiscoveredModel[] = [];
  for (const item of data) {
    const m = asRecord(item);
    if (!m) continue;
    const id = asString(m.id) || asString(m.name);
    if (!id) continue;
    const pricing = parsePricing(m.pricing);
    out.push({
      id,
      name: asString(m.display_name) || asString(m.name) || id,
      ownedBy: asString(m.owned_by) || kind,
      contextLength: asNumber(m.context_length, 0),
      costInputPer1k: pricing?.in ?? 0,
      costOutputPer1k: pricing?.out ?? 0,
      priceSource: pricing ? "provider" : "none",
    });
  }
  return out;
}

export function diffDiscovered(
  before: DiscoveredModel[],
  after: DiscoveredModel[],
): DiscoveredDiff {
  const prev = new Map(before.map((m) => [m.id, m]));
  const next = new Map(after.map((m) => [m.id, m]));
  const added = [...next.keys()].filter((id) => !prev.has(id)).sort();
  const removed = [...prev.keys()].filter((id) => !next.has(id)).sort();
  const repriced: RepricedModel[] = [];
  let edited = before.length !== after.length;
  for (const [id, model] of next) {
    const old = prev.get(id);
    if (!old) continue;
    if (JSON.stringify(old) !== JSON.stringify(model)) edited = true;
    if (
      old.costInputPer1k === model.costInputPer1k &&
      old.costOutputPer1k === model.costOutputPer1k
    ) {
      continue;
    }
    repriced.push({
      id,
      from: { in: old.costInputPer1k, out: old.costOutputPer1k },
      to: { in: model.costInputPer1k, out: model.costOutputPer1k },
    });
  }
  repriced.sort((a, b) => a.id.localeCompare(b.id));
  return {
    added,
    removed,
    repriced,
    changed: edited || added.length > 0 || removed.length > 0,
  };
}

function preview(ids: string[]): string {
  const head = ids.slice(0, ALERT_LIST_LIMIT).join(", ");
  const rest = ids.length - ALERT_LIST_LIMIT;
  return rest > 0 ? `${head} +${rest} more` : head;
}

function alertMessage(name: string, diff: DiscoveredDiff, groups: string[]): string {
  const parts = [`provider ${name}: ${diff.added.length} added, ${diff.removed.length} removed`];
  if (diff.added.length) parts.push(`added ${preview(diff.added)}`);
  if (diff.removed.length) parts.push(`removed ${preview(diff.removed)}`);
  if (groups.length) parts.push(`model groups still routing to removed models: ${preview(groups)}`);
  return parts.join("; ");
}

export async function refreshProviderModels(
  row: ProviderSyncRecord,
  actor: string,
): Promise<{ provider: ProviderSyncRecord; diff: DiscoveredDiff }> {
  const models = await fetchProviderModels(row.kind, row.baseUrl, open(row.apiKey));
  const before = discoveredOf(row.discovered);
  if (models.length === 0 && before.length > 0) throw new Error("UPSTREAM_EMPTY");
  const diff = diffDiscovered(before, models);
  if (!diff.changed) return { provider: row, diff };

  const baseline = before.length === 0;
  const notable = diff.added.length + diff.removed.length + diff.repriced.length > 0;
  let groups: string[] = [];
  let provider: ProviderSyncRecord;
  try {
    provider = await prisma.$transaction(async (tx) => {
      const updated = await tx.providerConnection.update({
        where: { id: row.id, updatedAt: row.updatedAt },
        data: { discovered: models },
      });
      if (baseline) {
        await tx.gatewayAuditLog.create({
          data: {
            actor,
            action: "provider.models_discovered",
            objectType: "provider",
            objectId: row.id,
            afterJson: JSON.stringify({ name: row.name, kind: row.kind, count: models.length }),
          },
        });
        return updated;
      }
      if (!notable) return updated;
      const affected = diff.removed.length
        ? await tx.deployment.findMany({
            where: { providerId: row.id, model: { in: diff.removed } },
            select: { id: true, groupAlias: true, model: true },
          })
        : [];
      groups = [...new Set(affected.map((d) => d.groupAlias))].sort();
      await tx.gatewayAuditLog.create({
        data: {
          actor,
          action: "provider.models_changed",
          objectType: "provider",
          objectId: row.id,
          afterJson: JSON.stringify({
            name: row.name,
            kind: row.kind,
            added: diff.added,
            removed: diff.removed,
            repriced: diff.repriced,
            affected: affected.map((d) => ({
              deployment: d.id,
              group: d.groupAlias,
              model: d.model,
            })),
          }),
        },
      });
      return updated;
    });
  } catch (error) {
    if (!isPrismaCode(error, "P2025")) throw error;
    const current = await prisma.providerConnection.findUnique({ where: { id: row.id } });
    if (!current) throw new Error("NOT_FOUND", { cause: error });
    return { provider: current, diff: UNCHANGED };
  }

  if (!baseline && notable) {
    logger.info("model_sync.changed", {
      provider: row.id,
      kind: row.kind,
      added: diff.added.length,
      removed: diff.removed.length,
      repriced: diff.repriced.length,
      affectedGroups: groups.length,
    });
  }
  if (!baseline && (diff.added.length || diff.removed.length)) {
    await fireAlert("provider_models_changed", alertMessage(row.name, diff, groups));
  }
  return { provider, diff };
}
