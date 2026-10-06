import "server-only";
import type { WorkerMode, HealthState } from "@/types/jobs";

const BOOT_KEY = Symbol.for("llmhub.worker.health");

function state(): HealthState {
  const g = globalThis as unknown as Record<symbol, HealthState>;
  if (!g[BOOT_KEY]) g[BOOT_KEY] = { mode: "unavailable" };
  return g[BOOT_KEY];
}

export function setWorkerMode(mode: WorkerMode): void {
  state().mode = mode;
}

export function getWorkerMode(): WorkerMode {
  return state().mode;
}

export function workerHealthPayload() {
  return { mode: getWorkerMode() };
}
