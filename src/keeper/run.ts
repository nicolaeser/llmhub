import "server-only";
import { refreshDueLogins, syncLoginJournal } from "@/lib/gateway/upstreams/credentials";
import { loginJournal } from "@/lib/gateway/upstreams/login-journal";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { runKeeperCycle, type KeeperFailures, type KeeperStep } from "./cycle";
import { KEEPER_CYCLE_MS, KEEPER_STUCK_MS, writeHeartbeat } from "./heartbeat";

const STEPS: KeeperStep[] = [
  { name: "login_journal", run: (now) => syncLoginJournal(now) },
  { name: "sign_in_refresh", run: (now) => refreshDueLogins(now) },
];

export async function runKeeper(): Promise<void> {
  const failures: KeeperFailures = new Map();
  let stopping = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cycle = async () => {
    const watchdog = setTimeout(() => {
      logger.error("keeper.cycle_stuck", { limitMs: KEEPER_STUCK_MS });
      process.exit(1);
    }, KEEPER_STUCK_MS);
    try {
      await runKeeperCycle(STEPS, failures);
      await writeHeartbeat().catch((err) => logger.warn("keeper.heartbeat_failed", errorFields(err)));
    } finally {
      clearTimeout(watchdog);
    }
  };

  const loop = () => {
    running = cycle()
      .catch((err) => logger.error("keeper.cycle_failed", errorFields(err)))
      .finally(() => {
        running = null;
        if (!stopping) timer = setTimeout(loop, KEEPER_CYCLE_MS);
      });
  };

  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    logger.info("keeper.stopping", { signal });
    await running;
    logger.info("keeper.stopped");
    process.exit(0);
  };

  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  logger.info("keeper.started", { cycleMs: KEEPER_CYCLE_MS, journal: await loginJournal.available() });
  loop();
}
