import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { refreshProviderModels } from "@/lib/gateway/upstreams/discovery";
import { catalogInputs, entryKey, persist } from "@/lib/gateway/catalog/catalog-entries";
import { addRoute } from "@/lib/gateway/catalog/catalog-routes";
import { acquireLock, CATALOG_REFRESH_MS, getCatalogState, releaseLock, saveState } from "@/lib/gateway/catalog/catalog-state";
import { askJevStaged, jevFingerprint, jevRoute } from "@/lib/gateway/catalog/jev";
import { autoRouteEntries, JEV_SUGGEST_CONFIDENCE } from "@/lib/gateway/catalog/model-catalog";
import { catalogRouting, getEnterprise } from "@/lib/settings/enterprise";
import { logger } from "@/lib/logging/logger";
import type {
  CatalogEntryPlan,
  CatalogProviderFailure,
  CatalogSource,
  CatalogState,
  JevTask,
  CatalogRouting,
  JevSettings,
} from "@/types/model-catalog";

const FRESH_SLACK_MS = 300_000;
const JEV_STEP_TASKS = 100;
const JEV_CONCURRENCY = 4;

async function runLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function classify(
  entries: CatalogEntryPlan[],
  tasks: JevTask[],
  settings: JevSettings | undefined,
): Promise<CatalogState["jev"]> {
  const route = await jevRoute(settings);
  const result = {
    configured: Boolean(route),
    asked: 0,
    matched: 0,
    pending: tasks.length,
    cost: 0,
    error: "",
    settings: jevFingerprint(settings),
  };
  if (!route || !tasks.length) return result;
  const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
  const classifiedAt = new Date();
  await runLimited(tasks.slice(0, JEV_STEP_TASKS), JEV_CONCURRENCY, async (task) => {
    if (result.error) return;
    try {
      const { verdict, cost } = await askJevStaged(route, task);
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

async function applyAutoRoutes(
  actor: string,
  entries: CatalogEntryPlan[],
  inputs: Awaited<ReturnType<typeof catalogInputs>>,
  routing: CatalogRouting,
): Promise<number> {
  const due = autoRouteEntries(entries, inputs.groups, routing);
  const routed: { provider: string; model: string; alias: string; source: CatalogSource; confidence: number }[] = [];
  for (const entry of due) {
    const model = inputs.discovered.get(entry.providerId)?.find((item) => item.id === entry.upstreamId);
    const provider = inputs.providers.find((item) => item.id === entry.providerId);
    if (!model || !provider || provider.internal) continue;
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
  const [inputs, enterprise] = await Promise.all([catalogInputs(), getEnterprise()]);
  const { entries, jev } = inputs.plan;
  const classified = await classify(entries, jev, enterprise.catalog_jev);
  const autoRouted = await applyAutoRoutes(actor, entries, inputs, catalogRouting(enterprise));
  await persist(entries, inputs.stored);
  return { entries: entries.length, autoRouted, jev: classified };
}

function partialState(
  previous: CatalogState,
  refreshed: Set<string>,
  failed: CatalogProviderFailure[],
  providers: { id: string }[],
  rebuilt: Awaited<ReturnType<typeof rebuildCatalog>>,
): CatalogState {
  const present = new Set(providers.map((provider) => provider.id));
  return {
    ...previous,
    providers: providers.length,
    failed: [
      ...previous.failed.filter((row) => present.has(row.providerId) && !refreshed.has(row.providerId)),
      ...failed,
    ],
    ...rebuilt,
  };
}

export async function refreshCatalog(input: {
  actor: string;
  force: boolean;
  providers?: string[];
}): Promise<{ state: CatalogState | null; skipped: boolean; changed: number }> {
  const previous = await getCatalogState();
  const partial = input.providers !== undefined && previous !== null;
  if (
    !input.force &&
    !partial &&
    previous &&
    Date.now() - Date.parse(previous.refreshedAt) < CATALOG_REFRESH_MS - FRESH_SLACK_MS
  ) {
    return { state: previous, skipped: true, changed: 0 };
  }
  const lock = await acquireLock();
  if (!lock) {
    if (input.force || partial) throw new Error("CATALOG_BUSY");
    return { state: previous, skipped: true, changed: 0 };
  }
  try {
    const started = Date.now();
    const all = await prisma.providerConnection.findMany({ orderBy: { createdAt: "asc" } });
    const refreshed = new Set(partial ? input.providers : all.map((row) => row.id));
    const providers = all.filter((row) => refreshed.has(row.id));
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
    const state: CatalogState = partial
      ? partialState(previous, refreshed, failed, all, rebuilt)
      : {
          refreshedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          providers: all.length,
          failed,
          ...rebuilt,
        };
    await saveState(state);
    return { state, skipped: false, changed: changedProviders };
  } finally {
    await releaseLock(lock);
  }
}
