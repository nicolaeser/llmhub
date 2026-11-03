import "server-only";
import { clientClosedError, GateError } from "@/lib/gateway/errors";
import type { ConcurrencyGate, ConcurrencyWaiter, PermitOptions } from "@/types/routing";

export const CONCURRENCY_WAIT_MS = 5_000;
export const CONCURRENCY_RETRY_MS = 1_000;
const QUEUE_PER_PERMIT = 4;
const MIN_QUEUE = 16;
const MAX_QUEUE = 1_024;

const globalForGates = globalThis as unknown as { __llmhubConcurrencyGates?: Map<string, ConcurrencyGate> };

function gates(): Map<string, ConcurrencyGate> {
  globalForGates.__llmhubConcurrencyGates ??= new Map();
  return globalForGates.__llmhubConcurrencyGates;
}

export function queueCapacity(limit: number): number {
  return Math.min(MAX_QUEUE, Math.max(MIN_QUEUE, limit * QUEUE_PER_PERMIT));
}

export function concurrencyLimitedError(now = Date.now()): GateError {
  return new GateError(429, "concurrency_limit_exceeded", "too many concurrent requests for this provider; retry shortly", {
    retryAt: now + CONCURRENCY_RETRY_MS,
  });
}

export function isConcurrencyLimited(err: unknown): err is GateError {
  return err instanceof GateError && err.code === "concurrency_limit_exceeded";
}

function unlimited(limit: number): boolean {
  return !(limit > 0);
}

export function hasRoom(key: string, limit: number): boolean {
  if (unlimited(limit)) return true;
  const gate = gates().get(key);
  return !gate || (gate.active < limit && !gate.queue.length);
}

function wake(gate: ConcurrencyGate): void {
  while (gate.queue.length && gate.active < gate.limit) gate.queue.shift()!.grant();
}

function drain(key: string, gate: ConcurrencyGate): void {
  wake(gate);
  if (!gate.active && !gate.queue.length && gates().get(key) === gate) gates().delete(key);
}

function permit(key: string, gate: ConcurrencyGate): () => void {
  gate.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gate.active -= 1;
    drain(key, gate);
  };
}

export function takePermit(key: string, limit: number, opts: PermitOptions = {}): Promise<() => void> {
  if (unlimited(limit)) return Promise.resolve(() => {});
  if (opts.signal?.aborted) return Promise.reject(clientClosedError());
  const all = gates();
  const gate = all.get(key) ?? { active: 0, limit, queue: [] };
  all.set(key, gate);
  gate.limit = limit;
  wake(gate);
  if (gate.active < limit && !gate.queue.length) return Promise.resolve(permit(key, gate));
  const waitMs = opts.waitMs ?? CONCURRENCY_WAIT_MS;
  if (waitMs <= 0 || gate.queue.length >= queueCapacity(limit)) return Promise.reject(concurrencyLimitedError());
  return new Promise((resolve, reject) => {
    const leave = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const index = gate.queue.indexOf(waiter);
      if (index >= 0) gate.queue.splice(index, 1);
    };
    const waiter: ConcurrencyWaiter = {
      grant: () => {
        leave();
        resolve(permit(key, gate));
      },
    };
    const giveUp = (err: GateError) => {
      leave();
      drain(key, gate);
      reject(err);
    };
    const onAbort = () => giveUp(clientClosedError());
    const timer = setTimeout(() => giveUp(concurrencyLimitedError()), waitMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    gate.queue.push(waiter);
  });
}

export function concurrencySnapshot(key: string): { active: number; queued: number } {
  const gate = gates().get(key);
  return { active: gate?.active ?? 0, queued: gate?.queue.length ?? 0 };
}

export function resetConcurrencyGates(): void {
  gates().clear();
}
