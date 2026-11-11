import "server-only";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { withTimeout } from "@/lib/utils/timeout";
import {
  KEEPER_CYCLE_MS,
  KEEPER_DATABASE_PING_MS,
  KEEPER_DATABASE_WAIT_ATTEMPTS,
  KEEPER_DATABASE_WAIT_MS,
  KEEPER_RETRY_MS,
} from "./heartbeat";

export const REPEATED_FAILURE_LOG_EVERY = 15;

export type KeeperStep = { name: string; run: (now: number) => Promise<number> };

export type KeeperFailures = Map<string, number>;

export async function runKeeperCycle(steps: KeeperStep[], failures: KeeperFailures, now = Date.now()): Promise<number> {
  let changed = 0;
  for (const step of steps) {
    try {
      const count = await step.run(now);
      const failed = failures.get(step.name);
      if (failed) {
        failures.delete(step.name);
        logger.info("keeper.step_recovered", { step: step.name, failures: failed });
      }
      if (count > 0) logger.info("keeper.step_done", { step: step.name, changed: count });
      changed += count;
    } catch (err) {
      const consecutive = (failures.get(step.name) ?? 0) + 1;
      failures.set(step.name, consecutive);
      if (consecutive === 1 || consecutive % REPEATED_FAILURE_LOG_EVERY === 0) {
        logger.error("keeper.step_failed", { step: step.name, consecutive, ...errorFields(err) });
      }
    }
  }
  return changed;
}

export function nextCycleDelay(failures: KeeperFailures, cycleMs = KEEPER_CYCLE_MS, retryMs = KEEPER_RETRY_MS): number {
  const consecutive = Math.max(0, ...failures.values());
  if (consecutive === 0) return cycleMs;
  return Math.min(cycleMs, retryMs[consecutive - 1] ?? cycleMs);
}

export async function waitForDatabase(
  ping: () => Promise<unknown>,
  {
    attempts = KEEPER_DATABASE_WAIT_ATTEMPTS,
    pauseMs = KEEPER_DATABASE_WAIT_MS,
    pingMs = KEEPER_DATABASE_PING_MS,
    stopped = () => false,
    onAttempt = async () => {},
  }: {
    attempts?: number;
    pauseMs?: number;
    pingMs?: number;
    stopped?: () => boolean;
    onAttempt?: () => Promise<unknown>;
  } = {},
): Promise<boolean> {
  const startedAt = Date.now();
  const deadline = startedAt + attempts * pauseMs;
  let open: Promise<unknown> | null = null;
  const answer = () => {
    if (!open) {
      const started = ping().finally(() => {
        if (open === started) open = null;
      });
      started.catch(() => undefined);
      open = started;
    }
    return open;
  };
  for (let attempt = 1; ; attempt += 1) {
    if (stopped()) return false;
    try {
      await withTimeout(answer(), pingMs, "the database did not answer in time");
      if (attempt > 1) logger.info("keeper.database_ready", { waitedMs: Date.now() - startedAt });
      return true;
    } catch (err) {
      if (attempt === 1) logger.info("keeper.database_waiting", errorFields(err));
      if (attempt >= attempts || Date.now() >= deadline) {
        logger.warn("keeper.database_unavailable", { waitedMs: Date.now() - startedAt, ...errorFields(err) });
        return false;
      }
    }
    await onAttempt();
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}
