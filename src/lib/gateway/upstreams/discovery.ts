import "server-only";
import prisma from "@/lib/db/prisma";
import { isPrismaCode } from "@/lib/auth/errors";
import { env } from "@/lib/env";
import { fireAlert } from "@/lib/alerts/notify";
import { antigravityModels } from "@/lib/gateway/upstreams/antigravity";
import { fetchAvailableModels } from "@/lib/gateway/upstreams/antigravity-api";
import { devinModelsReply } from "@/lib/gateway/upstreams/devin-api";
import { fetchGeminiModels, fetchVertexModels } from "@/lib/gateway/upstreams/google-models";
import { museModels } from "@/lib/gateway/upstreams/muse";
import { isSignInKind, PROVIDER_CATALOG, speaksMuse } from "@/lib/gateway/upstreams/provider-kinds";
import { CLAUDE_OAUTH_BETAS } from "@/lib/gateway/upstreams/claude";
import { CODEX_CLIENT_VERSION, codexModelFacts } from "@/lib/gateway/upstreams/codex";
import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { providerAuth } from "@/lib/gateway/upstreams/credentials";
import { GateError } from "@/lib/gateway/errors";
import { readJsonOr } from "@/lib/utils/json";
import { discoveredOf, parsePricing } from "@/lib/gateway/upstreams/provider-prices";
import { logger } from "@/lib/logging/logger";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";
import type {
  ProviderSyncRecord,
  DiscoveredDiff,
  DiscoveredModel,
  ModelPrice,
  RepricedModel,
  UpstreamAuth,
} from "@/types/providers";

const ALERT_LIST_LIMIT = 10;
const PRICE_EPSILON = 1e-9;

const UNCHANGED: DiscoveredDiff = { added: [], removed: [], repriced: [], changed: false };

function modelsUrl(kind: string, base: string): string {
  let b = base.trim().replace(/\/$/, "");
  if (!b) {
    b = (PROVIDER_CATALOG.find((k) => k.kind === kind)?.default_base_url ?? "").replace(/\/$/, "");
  }
  if (!b) throw new Error("BASE_URL_REQUIRED");
  if (kind === "codex") return `${b}/models?client_version=${CODEX_CLIENT_VERSION}`;
  if (b.endsWith("/models")) return b;
  if (b.endsWith("/v1")) return `${b}/models`;
  return `${b}/v1/models`;
}

async function fetchAntigravityModels(auth: UpstreamAuth): Promise<DiscoveredModel[]> {
  const { status, json } = await fetchAvailableModels(auth);
  if (status === 401 || status === 403) throw new Error("UPSTREAM_AUTH");
  if (status < 200 || status >= 300) throw new Error("UPSTREAM_FAILED");
  return antigravityModels(json);
}

async function fetchMuseModels(kind: string, baseUrl: string, auth: UpstreamAuth): Promise<DiscoveredModel[]> {
  try {
    const listed = await fetchProviderModels(kind, baseUrl, auth.key, auth.headers);
    return listed.length ? listed : museModels();
  } catch (error) {
    if (error instanceof Error && error.message === "UPSTREAM_AUTH") throw error;
    return museModels();
  }
}

async function fetchDevinModels(auth: UpstreamAuth): Promise<DiscoveredModel[]> {
  const { status, models } = await devinModelsReply(auth.key);
  if (status === 401 || status === 403) throw new Error("UPSTREAM_AUTH");
  if (status < 200 || status >= 300) throw new Error("UPSTREAM_FAILED");
  return models;
}

function providerBase(row: ProviderSyncRecord): string {
  return row.baseUrl.trim() || PROVIDER_CATALOG.find((spec) => spec.kind === row.kind)?.default_base_url || "";
}

async function fetchConnectionModels(row: ProviderSyncRecord, auth: UpstreamAuth): Promise<DiscoveredModel[]> {
  if (row.kind === "antigravity") return fetchAntigravityModels(auth);
  if (row.kind === "devin") return fetchDevinModels(auth);
  if (row.kind === "gemini") return fetchGeminiModels(providerBase(row), auth);
  if (row.kind === "vertex") return fetchVertexModels(providerBase(row), auth);
  if (speaksMuse(row.kind)) return fetchMuseModels(row.kind, row.baseUrl, auth);
  return fetchProviderModels(row.kind, row.baseUrl, auth.key, auth.headers);
}

export async function fetchProviderModels(
  kind: string,
  baseUrl: string,
  apiKey: string,
  authHeaders: Record<string, string> = {},
): Promise<DiscoveredModel[]> {
  const url = modelsUrl(kind, baseUrl);
  const headers: Record<string, string> = { ...authHeaders, Accept: "application/json" };
  if (apiKey) {
    if (kind === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }
  if (kind === "claude") headers["anthropic-beta"] = CLAUDE_OAUTH_BETAS.join(",");
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
  const json = await readJsonOr(resp, {});
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
    const id = asString(m.id) || asString(m.slug) || asString(m.name);
    if (!id || (kind === "codex" && m.visibility !== undefined && m.visibility !== "list")) continue;
    const pricing = parsePricing(m.pricing);
    out.push({
      id,
      name: asString(m.display_name) || asString(m.name) || id,
      ownedBy: asString(m.owned_by) || kind,
      contextLength: asNumber(m.context_length, asNumber(m.context_window, 0)),
      costInputPer1k: pricing?.in ?? 0,
      costOutputPer1k: pricing?.out ?? 0,
      priceSource: pricing ? "provider" : "none",
      ...(kind === "codex" ? codexModelFacts(m) : {}),
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

function samePrice(route: { costInput: Prisma.Decimal | number; costOutput: Prisma.Decimal | number }, price: ModelPrice) {
  return (
    Math.abs(money(route.costInput) - price.in) < PRICE_EPSILON &&
    Math.abs(money(route.costOutput) - price.out) < PRICE_EPSILON
  );
}

export function followingRoutes<
  T extends { id: string; model: string; costInput: Prisma.Decimal | number; costOutput: Prisma.Decimal | number },
>(routes: T[], repriced: RepricedModel[]): { id: string; model: string; to: ModelPrice }[] {
  const byModel = new Map(repriced.map((row) => [row.id, row]));
  return routes.flatMap((route) => {
    const change = byModel.get(route.model);
    if (!change || (change.to.in === 0 && change.to.out === 0) || !samePrice(route, change.from)) return [];
    return [{ id: route.id, model: route.model, to: change.to }];
  });
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
  const auth = await providerAuth(row).catch((error: unknown) => {
    if (!(error instanceof GateError)) throw error;
    if (isSignInKind(row.kind)) throw new Error("SIGN_IN_EXPIRED", { cause: error });
    throw new Error(error.code === "no_provider_key" ? "UPSTREAM_AUTH" : "UPSTREAM_FAILED", { cause: error });
  });
  const models = await fetchConnectionModels(row, auth);
  const before = discoveredOf(row.discovered);
  if (models.length === 0 && before.length > 0) throw new Error("UPSTREAM_EMPTY");
  const diff = diffDiscovered(before, models);
  if (!diff.changed) return { provider: row, diff };

  const baseline = before.length === 0;
  const notable = diff.added.length + diff.removed.length + diff.repriced.length > 0;
  let groups: string[] = [];
  let repricedRoutes = 0;
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
      const priced = diff.repriced.length
        ? await tx.deployment.findMany({
            where: { providerId: row.id, model: { in: diff.repriced.map((item) => item.id) } },
            select: { id: true, groupAlias: true, model: true, costInput: true, costOutput: true },
          })
        : [];
      const following = followingRoutes(priced, diff.repriced);
      for (const route of following) {
        await tx.deployment.update({
          where: { id: route.id },
          data: { costInput: route.to.in, costOutput: route.to.out },
        });
      }
      repricedRoutes = following.length;
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
            repricedRoutes: following.map((route) => route.id),
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
      repricedRoutes,
      affectedGroups: groups.length,
    });
  }
  if (!baseline && (diff.added.length || diff.removed.length)) {
    await fireAlert("provider_models_changed", alertMessage(row.name, diff, groups));
  }
  return { provider, diff };
}
