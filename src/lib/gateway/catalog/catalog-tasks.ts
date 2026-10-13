import "server-only";

import { refreshCatalog } from "@/lib/gateway/catalog/catalog-sync";
import { jobsEnabled } from "@/lib/jobs/connection";
import { getModelsQueue, QUEUE_NAMES } from "@/lib/jobs/queues";
import { logger } from "@/lib/logging/logger";
import type { CatalogState } from "@/types/model-catalog";
import type { GlobalWithWorkerBoot, ModelSyncJobData, ModelSyncResult } from "@/types/jobs";

export const CATALOG_BUSY_DELAY_MS = 60_000;
export const JEV_STEP_DELAY_MS = 60_000;
export const JEV_RATE_LIMIT_DELAY_MS = 900_000;

const LOCAL_BUSY_RETRIES = 15;
const DEDUP_MIN_TTL_MS = 1_000;
const TERMINAL_JEV_ERRORS = new Set(["JEV_AUTH", "JEV_CREDITS"]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function catalogTaskId(data: ModelSyncJobData): string {
  if (data.task === "provider") return `catalog-provider-${data.providerId ?? ""}`;
  return `catalog-${data.task ?? "refresh"}`;
}

export function jevFollowUpDelay(state: CatalogState | null): number | null {
  const jev = state?.jev;
  if (!jev?.configured || jev.pending === 0 || jev.asked === 0) return null;
  if (TERMINAL_JEV_ERRORS.has(jev.error)) return null;
  return jev.error === "JEV_RATE_LIMITED" ? JEV_RATE_LIMIT_DELAY_MS : JEV_STEP_DELAY_MS;
}

function refreshFor(data: ModelSyncJobData) {
  if (data.task === "provider") {
    return refreshCatalog({ actor: "worker", force: true, providers: data.providerId ? [data.providerId] : [] });
  }
  if (data.task === "rebuild") return refreshCatalog({ actor: "worker", force: true, providers: [] });
  return refreshCatalog({ actor: "worker", force: false });
}

async function continueJev(state: CatalogState | null): Promise<void> {
  const delay = jevFollowUpDelay(state);
  if (delay !== null) await scheduleCatalogTask({ task: "rebuild" }, delay);
}

export async function runCatalogTask(data: ModelSyncJobData = {}): Promise<ModelSyncResult> {
  const { state, skipped, changed } = await refreshFor(data);
  if (skipped || !state) return { providers: 0, changed: 0, failed: 0, skipped: true };
  await continueJev(state);
  return { providers: state.providers, changed, failed: state.failed.length, skipped: false };
}

export async function refreshCatalogNow(actor: string): Promise<void> {
  const { state } = await refreshCatalog({ actor, force: true });
  await continueJev(state);
}

function localTimers(): Map<string, ReturnType<typeof setTimeout>> {
  const g = globalThis as GlobalWithWorkerBoot;
  g.__llmhubCatalogTimers ??= new Map();
  return g.__llmhubCatalogTimers;
}

function runLocally(id: string, data: ModelSyncJobData, delayMs: number, attempt: number): void {
  const timers = localTimers();
  if (timers.has(id)) return;
  const timer = setTimeout(() => {
    timers.delete(id);
    void runCatalogTask(data).catch((err) => {
      if (errorMessage(err) === "CATALOG_BUSY" && attempt < LOCAL_BUSY_RETRIES) {
        runLocally(id, data, CATALOG_BUSY_DELAY_MS, attempt + 1);
        return;
      }
      logger.error("catalog.task_failed", { task: data.task ?? "refresh", err: errorMessage(err), attempt });
    });
  }, delayMs);
  timer.unref();
  timers.set(id, timer);
}

export function stopLocalCatalogTasks(): void {
  const timers = localTimers();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

export async function scheduleCatalogTask(data: ModelSyncJobData, delayMs = 0): Promise<void> {
  const id = catalogTaskId(data);
  if (jobsEnabled()) {
    try {
      await getModelsQueue().add(QUEUE_NAMES.models, data, {
        delay: delayMs,
        deduplication: { id, ttl: Math.max(delayMs, DEDUP_MIN_TTL_MS) },
      });
      return;
    } catch (err) {
      logger.warn("catalog.enqueue_failed", { task: data.task ?? "refresh", err: errorMessage(err) });
    }
  }
  runLocally(id, data, delayMs, 1);
}
