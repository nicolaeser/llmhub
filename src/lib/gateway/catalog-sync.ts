import "server-only";
import prisma from "@/lib/db/prisma";
import { isPrismaCode } from "@/lib/auth/errors";
import { writeAudit } from "@/lib/gateway/audit";
import { asRecord, asNumber, asString } from "@/lib/gateway/core";
import { refreshProviderModels } from "@/lib/gateway/discovery";
import { askJev, jevReady } from "@/lib/gateway/jev";
import {
  activationEntries,
  autoRouteEntries,
  catalogStatus,
  JEV_SUGGEST_CONFIDENCE,
  planCatalog,
  trustedKind,
} from "@/lib/gateway/model-catalog";
import { RESERVED_ALIASES } from "@/lib/gateway/model-alias";
import { discoveredOf } from "@/lib/gateway/provider-prices";
import { getEnterprise } from "@/lib/gateway/settings";
import { logger } from "@/lib/logging/logger";
import type { DiscoveredModel } from "@/types/gateway";
import type {
  CatalogEntryPlan,
  CatalogEntryView,
  CatalogGroupView,
  CatalogProviderFailure,
  CatalogSource,
  CatalogState,
  CatalogView,
  JevTask,
} from "@/types/model-catalog";

export const CATALOG_REFRESH_MS = 7_200_000;

const CATALOG_STATE = "model_catalog_state";
const CATALOG_LOCK = "model_catalog_lock";
const LOCK_TTL_MS = 600_000;
const FRESH_SLACK_MS = 300_000;
const JEV_MAX_TASKS = 100;
const JEV_CONCURRENCY = 4;
const IMPORT_STRATEGY = "cost_lowest";
const IMPORT_RETRIES = 2;

const STATE_ORDER = { active: 0, disabled: 1, missing: 2 } as const;

const storedSelect = {
  providerId: true,
  upstreamId: true,
  name: true,
  vendor: true,
  alias: true,
  source: true,
  confidence: true,
  disabled: true,
  classifiedAt: true,
  updatedAt: true,
} as const;

type StoredRow = {
  providerId: string;
  upstreamId: string;
  name: string;
  vendor: string;
  alias: string;
  source: string;
  confidence: number;
  disabled: boolean;
  classifiedAt: Date | null;
  updatedAt: Date;
};

type RouteTarget = {
  provider: { id: string; kind: string };
  model: DiscoveredModel;
  alias: string;
  vendor: string;
  displayName: string;
  strategy?: string;
  autoRoutes?: boolean;
};

type EntryRef = { providerId: string; upstreamId: string };

function entryKey(row: { providerId: string; upstreamId: string }): string {
  return `${row.providerId}\u0000${row.upstreamId}`;
}

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

async function saveState(state: CatalogState): Promise<void> {
  const value = JSON.stringify(state);
  await prisma.setting.upsert({ where: { key: CATALOG_STATE }, update: { value }, create: { key: CATALOG_STATE, value } });
}

async function acquireLock(): Promise<string | null> {
  const value = String(Date.now() + LOCK_TTL_MS);
  const claim = async () => {
    try {
      await prisma.setting.create({ data: { key: CATALOG_LOCK, value } });
      return true;
    } catch (error) {
      if (isPrismaCode(error, "P2002")) return false;
      throw error;
    }
  };
  if (await claim()) return value;
  const expired = await prisma.setting.deleteMany({ where: { key: CATALOG_LOCK, value: { lt: String(Date.now()) } } });
  if (expired.count && (await claim())) return value;
  return null;
}

async function releaseLock(value: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: CATALOG_LOCK, value } });
}

async function catalogInputs() {
  const [providers, groups, deployments, stored] = await Promise.all([
    prisma.providerConnection.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, kind: true, discovered: true },
    }),
    prisma.modelGroup.findMany({
      orderBy: { alias: "asc" },
      select: { alias: true, vendor: true, displayName: true, autoRoutes: true },
    }),
    prisma.deployment.findMany({ select: { providerId: true, model: true, groupAlias: true } }),
    prisma.catalogEntry.findMany({ select: storedSelect }),
  ]);
  const discovered = new Map(providers.map((provider) => [provider.id, discoveredOf(provider.discovered)]));
  const plan = planCatalog({
    providers: providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      models: (discovered.get(provider.id) ?? []).map((model) => ({ id: model.id, name: model.name })),
    })),
    groups,
    routes: deployments.flatMap((dep) =>
      dep.providerId ? [{ providerId: dep.providerId, model: dep.model, groupAlias: dep.groupAlias }] : [],
    ),
    stored,
  });
  return { providers, groups, stored, discovered, plan };
}

async function runLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function classify(entries: CatalogEntryPlan[], tasks: JevTask[]): Promise<CatalogState["jev"]> {
  const settings = (await getEnterprise()).catalog_jev;
  const result = { configured: jevReady(settings), asked: 0, matched: 0, pending: tasks.length, cost: 0, error: "" };
  if (!jevReady(settings) || !tasks.length) return result;
  const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
  const classifiedAt = new Date();
  await runLimited(tasks.slice(0, JEV_MAX_TASKS), JEV_CONCURRENCY, async (task) => {
    if (result.error) return;
    try {
      const { verdict, cost } = await askJev(settings, task);
      result.asked += 1;
      result.cost += cost;
      const entry = byKey.get(entryKey(task));
      if (!entry) return;
      entry.classifiedAt = classifiedAt;
      if (!verdict || verdict.confidence < JEV_SUGGEST_CONFIDENCE) return;
      entry.alias = verdict.alias;
      entry.source = "jev";
      entry.confidence = verdict.confidence;
      result.matched += 1;
    } catch (error) {
      result.error = error instanceof Error ? error.message : "JEV_FAILED";
    }
  });
  result.pending = tasks.length - result.asked;
  if (result.error) logger.warn("catalog.jev_failed", { code: result.error, asked: result.asked });
  return result;
}

function changed(prior: StoredRow, entry: CatalogEntryPlan): boolean {
  return (
    prior.name !== entry.name ||
    prior.vendor !== entry.vendor ||
    prior.alias !== entry.alias ||
    prior.source !== entry.source ||
    prior.confidence !== entry.confidence ||
    (prior.classifiedAt?.getTime() ?? null) !== (entry.classifiedAt?.getTime() ?? null)
  );
}

function entryData(entry: CatalogEntryPlan) {
  return {
    name: entry.name,
    vendor: entry.vendor,
    alias: entry.alias,
    source: entry.source,
    confidence: entry.confidence,
    classifiedAt: entry.classifiedAt,
  };
}

async function persist(entries: CatalogEntryPlan[], stored: StoredRow[]): Promise<void> {
  const keep = new Set(entries.map(entryKey));
  const priorByKey = new Map(stored.map((row) => [entryKey(row), row]));
  const stale = new Map<string, string[]>();
  for (const row of stored) {
    if (!keep.has(entryKey(row))) stale.set(row.providerId, [...(stale.get(row.providerId) ?? []), row.upstreamId]);
  }
  for (const [providerId, upstreamIds] of stale) {
    await prisma.catalogEntry.deleteMany({ where: { providerId, upstreamId: { in: upstreamIds } } });
  }
  const fresh = entries.filter((entry) => !priorByKey.has(entryKey(entry)));
  if (fresh.length) {
    await prisma.catalogEntry.createMany({
      data: fresh.map((entry) => ({
        providerId: entry.providerId,
        upstreamId: entry.upstreamId,
        disabled: entry.disabled,
        ...entryData(entry),
      })),
      skipDuplicates: true,
    });
  }
  for (const entry of entries) {
    const prior = priorByKey.get(entryKey(entry));
    if (!prior || !changed(prior, entry)) continue;
    await prisma.catalogEntry.updateMany({
      where: { providerId: entry.providerId, upstreamId: entry.upstreamId, updatedAt: prior.updatedAt },
      data: entryData(entry),
    });
  }
}

export async function addRoute(target: RouteTarget): Promise<"created" | "added" | "updated"> {
  const deployment = {
    kind: target.provider.kind,
    model: target.model.id,
    providerId: target.provider.id,
    weight: 1,
    costInput: target.model.costInputPer1k,
    costOutput: target.model.costOutputPer1k,
  };
  const existing = await prisma.modelGroup.findUnique({
    where: { alias: target.alias },
    select: { vendor: true, displayName: true, deployments: { select: { id: true, providerId: true, model: true } } },
  });
  if (!existing) {
    try {
      await prisma.modelGroup.create({
        data: {
          alias: target.alias,
          strategy: target.strategy ?? IMPORT_STRATEGY,
          numRetries: IMPORT_RETRIES,
          vendor: target.vendor,
          displayName: target.displayName,
          autoRoutes: target.autoRoutes ?? false,
          deployments: { create: deployment },
        },
      });
      return "created";
    } catch (error) {
      if (!isPrismaCode(error, "P2002")) throw error;
      await prisma.deployment.create({ data: { groupAlias: target.alias, ...deployment } });
      return "added";
    }
  }
  if (!existing.vendor || !existing.displayName) {
    await prisma.modelGroup.update({
      where: { alias: target.alias },
      data: { vendor: existing.vendor || target.vendor, displayName: existing.displayName || target.displayName },
    });
  }
  const duplicate = existing.deployments.find(
    (dep) => dep.providerId === target.provider.id && dep.model === target.model.id,
  );
  if (duplicate) {
    await prisma.deployment.update({
      where: { id: duplicate.id },
      data: { costInput: deployment.costInput, costOutput: deployment.costOutput },
    });
    return "updated";
  }
  await prisma.deployment.create({ data: { groupAlias: target.alias, ...deployment } });
  return "added";
}

export async function markRouted(entry: {
  providerId: string;
  upstreamId: string;
  alias: string;
  name: string;
  vendor: string;
}): Promise<void> {
  const data = { alias: entry.alias, source: "route", confidence: 1, disabled: false };
  await prisma.catalogEntry.upsert({
    where: { providerId_upstreamId: { providerId: entry.providerId, upstreamId: entry.upstreamId } },
    update: data,
    create: { providerId: entry.providerId, upstreamId: entry.upstreamId, name: entry.name, vendor: entry.vendor, ...data },
  });
}

async function applyAutoRoutes(
  actor: string,
  entries: CatalogEntryPlan[],
  inputs: Awaited<ReturnType<typeof catalogInputs>>,
): Promise<number> {
  const due = autoRouteEntries(entries, inputs.groups);
  const routed: { provider: string; model: string; alias: string; source: CatalogSource; confidence: number }[] = [];
  for (const entry of due) {
    const model = inputs.discovered.get(entry.providerId)?.find((item) => item.id === entry.upstreamId);
    const provider = inputs.providers.find((item) => item.id === entry.providerId);
    if (!model || !provider) continue;
    await addRoute({ provider, model, alias: entry.alias, vendor: entry.vendor, displayName: entry.name });
    routed.push({
      provider: entry.providerId,
      model: entry.upstreamId,
      alias: entry.alias,
      source: entry.source,
      confidence: entry.confidence,
    });
    entry.source = "route";
    entry.confidence = 1;
  }
  if (routed.length) {
    await writeAudit({ actor, action: "catalog.auto_route", objectType: "catalog", objectId: "catalog", after: { routes: routed } });
  }
  return routed.length;
}

async function rebuildCatalog(actor: string) {
  const inputs = await catalogInputs();
  const { entries, jev } = inputs.plan;
  const classified = await classify(entries, jev);
  const autoRouted = await applyAutoRoutes(actor, entries, inputs);
  await persist(entries, inputs.stored);
  return { entries: entries.length, autoRouted, jev: classified };
}

export async function refreshCatalog(input: {
  actor: string;
  force: boolean;
}): Promise<{ state: CatalogState | null; skipped: boolean; changed: number }> {
  const previous = await getCatalogState();
  if (
    !input.force &&
    previous &&
    Date.now() - Date.parse(previous.refreshedAt) < CATALOG_REFRESH_MS - FRESH_SLACK_MS
  ) {
    return { state: previous, skipped: true, changed: 0 };
  }
  const lock = await acquireLock();
  if (!lock) {
    if (input.force) throw new Error("CATALOG_BUSY");
    return { state: previous, skipped: true, changed: 0 };
  }
  try {
    const started = Date.now();
    const providers = await prisma.providerConnection.findMany({ orderBy: { createdAt: "asc" } });
    const failed: CatalogProviderFailure[] = [];
    let changedProviders = 0;
    for (const row of providers) {
      try {
        const { diff } = await refreshProviderModels(row, input.actor);
        if (diff.changed) changedProviders += 1;
      } catch (error) {
        const code = error instanceof Error ? error.message : "UPSTREAM_FAILED";
        failed.push({ providerId: row.id, name: row.name, code });
        logger.warn("model_sync.provider_failed", { provider: row.id, kind: row.kind, err: code });
      }
    }
    const rebuilt = await rebuildCatalog(input.actor);
    const state: CatalogState = {
      refreshedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      providers: providers.length,
      failed,
      ...rebuilt,
    };
    await saveState(state);
    return { state, skipped: false, changed: changedProviders };
  } finally {
    await releaseLock(lock);
  }
}

export async function catalogTargets(providerId: string): Promise<Map<string, CatalogEntryPlan>> {
  const { plan } = await catalogInputs();
  return new Map(
    plan.entries.filter((entry) => entry.providerId === providerId).map((entry) => [entry.upstreamId, entry]),
  );
}

function entryView(
  row: StoredRow,
  provider: { name: string; kind: string },
): CatalogEntryView {
  const source = row.source as CatalogSource;
  return {
    providerId: row.providerId,
    providerName: provider.name,
    kind: provider.kind,
    upstreamId: row.upstreamId,
    name: row.name,
    source,
    confidence: row.confidence,
    status: catalogStatus({ source, disabled: row.disabled }),
    trusted: trustedKind(provider.kind),
  };
}

export async function loadCatalogView(): Promise<Omit<CatalogView, "canManage">> {
  const [rows, providers, groups, state, enterprise] = await Promise.all([
    prisma.catalogEntry.findMany({ select: storedSelect }),
    prisma.providerConnection.findMany({ select: { id: true, name: true, kind: true } }),
    prisma.modelGroup.findMany({
      orderBy: { alias: "asc" },
      select: { alias: true, enabled: true, vendor: true, displayName: true, autoRoutes: true },
    }),
    getCatalogState(),
    getEnterprise(),
  ]);
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const views = new Map<string, CatalogGroupView>();
  for (const group of groups) {
    views.set(group.alias, {
      alias: group.alias,
      vendor: group.vendor,
      displayName: group.displayName,
      state: group.enabled ? "active" : "disabled",
      autoRoutes: group.autoRoutes,
      entries: [],
    });
  }
  for (const row of rows) {
    const provider = byId.get(row.providerId);
    if (!provider || !row.alias) continue;
    const view = views.get(row.alias) ?? {
      alias: row.alias,
      vendor: "",
      displayName: "",
      state: "missing" as const,
      autoRoutes: false,
      entries: [],
    };
    view.entries.push(entryView(row, provider));
    if (view.state === "missing") {
      view.vendor ||= row.vendor;
      view.displayName ||= row.name;
    }
    views.set(row.alias, view);
  }
  const list = [...views.values()];
  for (const view of list) {
    view.entries.sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        a.providerName.localeCompare(b.providerName) ||
        a.upstreamId.localeCompare(b.upstreamId),
    );
  }
  list.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.alias.localeCompare(b.alias));
  return {
    groups: list,
    state,
    refreshMs: CATALOG_REFRESH_MS,
    jevReady: jevReady(enterprise.catalog_jev),
  };
}

async function reconcile(): Promise<void> {
  const inputs = await catalogInputs();
  await persist(inputs.plan.entries, inputs.stored);
}

async function routeTarget(ref: EntryRef) {
  const [entry, provider] = await Promise.all([
    prisma.catalogEntry.findUnique({
      where: { providerId_upstreamId: ref },
      select: storedSelect,
    }),
    prisma.providerConnection.findUnique({
      where: { id: ref.providerId },
      select: { id: true, kind: true, discovered: true },
    }),
  ]);
  if (!entry || !provider) throw new Error("NOT_FOUND");
  if (!entry.alias) throw new Error("CATALOG_TARGET_REQUIRED");
  const model =
    discoveredOf(provider.discovered).find((item) => item.id === entry.upstreamId) ??
    ({
      id: entry.upstreamId,
      name: entry.name || entry.upstreamId,
      ownedBy: "",
      contextLength: 0,
      costInputPer1k: 0,
      costOutputPer1k: 0,
      priceSource: "none",
    } satisfies DiscoveredModel);
  return { entry, provider, model };
}

async function unroute(entry: StoredRow): Promise<number> {
  const removed = await prisma.deployment.deleteMany({
    where: { groupAlias: entry.alias, providerId: entry.providerId, model: entry.upstreamId },
  });
  return removed.count;
}

export async function setEntryActive(actor: string, ref: EntryRef, active: boolean): Promise<void> {
  const { entry, provider, model } = await routeTarget(ref);
  if (active) {
    const outcome = await addRoute({
      provider,
      model,
      alias: entry.alias,
      vendor: entry.vendor,
      displayName: entry.name,
      autoRoutes: true,
    });
    await markRouted(entry);
    await writeAudit({
      actor,
      action: "catalog.route_enable",
      objectType: "model",
      objectId: entry.alias,
      after: { provider: entry.providerId, model: entry.upstreamId, outcome },
    });
  } else {
    const removed = await unroute(entry);
    await prisma.catalogEntry.update({
      where: { providerId_upstreamId: ref },
      data: { disabled: true, source: "manual", confidence: 1 },
    });
    await writeAudit({
      actor,
      action: "catalog.route_disable",
      objectType: "model",
      objectId: entry.alias,
      after: { provider: entry.providerId, model: entry.upstreamId, removed },
    });
  }
  await reconcile();
}

export async function assignEntry(actor: string, ref: EntryRef, alias: string): Promise<void> {
  const { entry, provider, model } = await routeTarget(ref);
  if (!alias) throw new Error("ALIAS_REQUIRED");
  if (RESERVED_ALIASES.has(alias)) throw new Error("ALIAS_RESERVED");
  if (alias === entry.alias) return;
  const wasRouted = entry.source === "route" && (await unroute(entry)) > 0;
  await prisma.catalogEntry.update({
    where: { providerId_upstreamId: ref },
    data: { alias, source: "manual", confidence: 1, disabled: false },
  });
  if (wasRouted) {
    await addRoute({ provider, model, alias, vendor: entry.vendor, displayName: entry.name, autoRoutes: true });
    await markRouted({ ...entry, alias });
  }
  await writeAudit({
    actor,
    action: "catalog.assign",
    objectType: "model",
    objectId: alias,
    before: { alias: entry.alias },
    after: { provider: entry.providerId, model: entry.upstreamId, alias, routed: wasRouted },
  });
  await reconcile();
}

export async function setGroupActive(actor: string, alias: string, active: boolean): Promise<void> {
  const group = await prisma.modelGroup.findUnique({ where: { alias }, select: { enabled: true } });
  if (group) {
    if (group.enabled === active) return;
    await prisma.modelGroup.update({ where: { alias }, data: { enabled: active } });
    await writeAudit({
      actor,
      action: active ? "model.enable" : "model.disable",
      objectType: "model",
      objectId: alias,
      before: { enabled: group.enabled },
      after: { enabled: active },
    });
    return;
  }
  if (!active) return;
  const rows = await prisma.catalogEntry.findMany({ where: { alias }, select: storedSelect });
  const providers = await prisma.providerConnection.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.providerId))] } },
    select: { id: true, kind: true, discovered: true },
  });
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const due = activationEntries(
    rows.flatMap((row) => {
      const provider = byId.get(row.providerId);
      return provider ? [{ ...row, source: row.source as CatalogSource, trusted: trustedKind(provider.kind), provider }] : [];
    }),
  );
  if (!due.length) throw new Error("CATALOG_NOTHING_TO_ACTIVATE");
  for (const row of due) {
    const model = discoveredOf(row.provider.discovered).find((item) => item.id === row.upstreamId);
    if (!model) continue;
    await addRoute({
      provider: row.provider,
      model,
      alias,
      vendor: row.vendor,
      displayName: row.name,
      autoRoutes: true,
    });
    await markRouted(row);
  }
  await writeAudit({
    actor,
    action: "catalog.activate",
    objectType: "model",
    objectId: alias,
    after: { routes: due.map((row) => ({ provider: row.providerId, model: row.upstreamId })) },
  });
  await reconcile();
}

export async function setGroupAutoRoutes(actor: string, alias: string, autoRoutes: boolean): Promise<void> {
  const group = await prisma.modelGroup.findUnique({ where: { alias }, select: { autoRoutes: true } });
  if (!group) throw new Error("NOT_FOUND");
  if (group.autoRoutes === autoRoutes) return;
  await prisma.modelGroup.update({ where: { alias }, data: { autoRoutes } });
  await writeAudit({
    actor,
    action: "model.auto_routes",
    objectType: "model",
    objectId: alias,
    before: { autoRoutes: group.autoRoutes },
    after: { autoRoutes },
  });
}
