import "server-only";
import { ERR_NO_HEALTHY } from "@/lib/gateway/core";
import type { Weighted, Deployment } from "@/types/gateway";

export function pickWeighted<T extends Weighted>(items: T[]): T {
  const eligible = items.filter((i) => (i.weight ?? 1) > 0);
  const pool = eligible.length ? eligible : items;
  if (!pool.length) throw ERR_NO_HEALTHY;
  const total = pool.reduce((n, i) => n + Math.max(1, i.weight ?? 1), 0);
  let cursor = Math.random() * total;
  for (const item of pool) {
    cursor -= Math.max(1, item.weight ?? 1);
    if (cursor <= 0) return item;
  }
  return pool[pool.length - 1];
}

export function pickLeastInflight(
  items: Deployment[],
  inflight: Map<string, number>,
): Deployment {
  if (!items.length) throw ERR_NO_HEALTHY;
  return [...items].sort(
    (a, b) => (inflight.get(a.id) ?? 0) - (inflight.get(b.id) ?? 0),
  )[0];
}

export function pickCostLowest(items: Deployment[]): Deployment {
  if (!items.length) throw ERR_NO_HEALTHY;
  return [...items].sort(
    (a, b) => a.cost_input_per_1k + a.cost_output_per_1k - (b.cost_input_per_1k + b.cost_output_per_1k),
  )[0];
}

export function pickPriority(items: Deployment[]): Deployment {
  if (!items.length) throw ERR_NO_HEALTHY;
  return [...items].sort((a, b) => b.weight - a.weight)[0];
}

export function pickLatencyEwma(
  items: Deployment[],
  ewma: Map<string, number>,
): Deployment {
  if (!items.length) throw ERR_NO_HEALTHY;
  return [...items].sort((a, b) => {
    const left = ewma.has(a.id) ? ewma.get(a.id)! : -1;
    const right = ewma.has(b.id) ? ewma.get(b.id)! : -1;
    if (left !== right) return left - right;
    return b.weight - a.weight;
  })[0];
}

const LATENCY_ALPHA = 0.3;

export function nextLatencyEwma(previous: number | undefined, sample: number): number {
  if (!(sample >= 0)) return previous ?? 0;
  if (previous == null) return sample;
  return LATENCY_ALPHA * sample + (1 - LATENCY_ALPHA) * previous;
}
