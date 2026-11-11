import "server-only";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";

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
