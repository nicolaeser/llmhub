import "server-only";
import { ERR_NO_HEALTHY } from "@/lib/gateway/core";
import type { Weighted, Deployment } from "@/types/gateway";

export type QuotaScores = Map<string, { pressure: number; reset: number }>;

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

export function pickRoundRobin<T extends { id: string }>(items: T[], cursors: Map<string, number>): T {
  if (!items.length) throw ERR_NO_HEALTHY;
  const ordered = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const key = ordered.map((item) => item.id).join(",");
  const cursor = cursors.get(key) ?? 0;
  cursors.set(key, cursor + 1);
  return ordered[cursor % ordered.length]!;
}

export function pickQuotaBalanced(
  items: Deployment[],
  scores: QuotaScores,
  inflight: Map<string, number>,
): Deployment {
  if (!items.length) throw ERR_NO_HEALTHY;
  return [...items].sort((a, b) => {
    const pressure = (scores.get(a.id)?.pressure ?? 50) - (scores.get(b.id)?.pressure ?? 50);
    if (pressure !== 0) return pressure;
    const load = (inflight.get(a.id) ?? 0) - (inflight.get(b.id) ?? 0);
    return load !== 0 ? load : b.weight - a.weight;
  })[0]!;
}

export function pickQuotaExpiring(
  items: Deployment[],
  scores: QuotaScores,
  inflight: Map<string, number>,
): Deployment {
  if (!items.length) throw ERR_NO_HEALTHY;
  return [...items].sort((a, b) => {
    const left = scores.get(a.id)?.reset ?? Infinity;
    const right = scores.get(b.id)?.reset ?? Infinity;
    if (left !== right) return left < right ? -1 : 1;
    const pressure = (scores.get(a.id)?.pressure ?? 50) - (scores.get(b.id)?.pressure ?? 50);
    if (pressure !== 0) return pressure;
    return (inflight.get(a.id) ?? 0) - (inflight.get(b.id) ?? 0);
  })[0]!;
}
