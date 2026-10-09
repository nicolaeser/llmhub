import { localMinute, scheduledPrice } from "@/lib/gateway/price-schedule";
import type { CostRates, PriceSchedule } from "@/types/gateway";
import type {
  MinuteTokens,
  PricedDeployment,
  TargetPrice,
  TrafficTotals,
  WhatIfDirection,
} from "@/types/what-if";

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;

export function ratesPriced(rates: CostRates): boolean {
  return rates.cost_input_per_1k > 0 || rates.cost_output_per_1k > 0;
}

export function meanRates(rows: CostRates[]): CostRates | null {
  if (!rows.length) return null;
  return {
    cost_input_per_1k: rows.reduce((sum, row) => sum + row.cost_input_per_1k, 0) / rows.length,
    cost_output_per_1k: rows.reduce((sum, row) => sum + row.cost_output_per_1k, 0) / rows.length,
  };
}

function weightedRates(rows: PricedDeployment[]): CostRates {
  const eligible = rows.filter((row) => row.weight > 0);
  const pool = eligible.length ? eligible : rows;
  const total = pool.reduce((sum, row) => sum + Math.max(1, row.weight), 0);
  return {
    cost_input_per_1k: pool.reduce((sum, row) => sum + row.cost_input_per_1k * Math.max(1, row.weight), 0) / total,
    cost_output_per_1k: pool.reduce((sum, row) => sum + row.cost_output_per_1k * Math.max(1, row.weight), 0) / total,
  };
}

function rateOnly(row: CostRates): CostRates {
  return { cost_input_per_1k: row.cost_input_per_1k, cost_output_per_1k: row.cost_output_per_1k };
}

export function expectedRates(strategy: string, deployments: PricedDeployment[]): CostRates | null {
  const priced = deployments.filter(ratesPriced);
  if (!priced.length) return null;
  switch (strategy) {
    case "cost_lowest":
      return rateOnly(
        priced.reduce((best, row) =>
          row.cost_input_per_1k + row.cost_output_per_1k < best.cost_input_per_1k + best.cost_output_per_1k
            ? row
            : best,
        ),
      );
    case "priority":
      return rateOnly(priced.reduce((best, row) => (row.weight > best.weight ? row : best)));
    case "weighted_random":
      return weightedRates(priced);
    default:
      return meanRates(priced);
  }
}

export function flatCost(rates: CostRates, prompt: number, completion: number): number {
  return (prompt / 1000) * rates.cost_input_per_1k + (completion / 1000) * rates.cost_output_per_1k;
}

export function addMinutes(
  buckets: Map<number, MinuteTokens>,
  rows: { createdAt: Date; promptTokens: number; completionTokens: number }[],
): void {
  for (const row of rows) {
    const minute = Math.floor(row.createdAt.getTime() / MS_PER_MINUTE);
    const bucket = buckets.get(minute) ?? { minute, prompt: 0, completion: 0 };
    bucket.prompt += row.promptTokens;
    bucket.completion += row.completionTokens;
    buckets.set(minute, bucket);
  }
}

export function zonedMinute(timeZone: string): (minute: number) => number {
  const offsets = new Map<number, number>();
  return (minute) => {
    const hour = Math.floor(minute / 60);
    let offset = offsets.get(hour);
    if (offset === undefined) {
      offset = localMinute(new Date(hour * 60 * MS_PER_MINUTE), timeZone) - (hour % 24) * 60;
      offsets.set(hour, offset);
    }
    const local = ((minute % MINUTES_PER_DAY) + offset) % MINUTES_PER_DAY;
    return local < 0 ? local + MINUTES_PER_DAY : local;
  };
}

export function scheduleCost(schedule: PriceSchedule, traffic: TrafficTotals, minutes: MinuteTokens[]): number {
  if (!schedule.windows.length) return flatCost(schedule.price, traffic.prompt, traffic.completion);
  const local = zonedMinute(schedule.time_zone);
  return minutes.reduce(
    (sum, bucket) =>
      sum +
      flatCost(scheduledPrice(schedule.price, schedule.windows, local(bucket.minute)), bucket.prompt, bucket.completion),
    0,
  );
}

export function isScheduled(price: TargetPrice): boolean {
  return price.schedule.windows.length > 0;
}

export function targetCost(price: TargetPrice, traffic: TrafficTotals, minutes: MinuteTokens[]): number {
  const routed = scheduleCost(price.schedule, traffic, minutes);
  return price.floor ? Math.max(routed, flatCost(price.floor, traffic.prompt, traffic.completion)) : routed;
}

export function compareCost(
  actual: number,
  simulated: number,
): { direction: WhatIfDirection; share: number; difference: number } {
  const difference = actual - simulated;
  if (!(actual > 0)) return { direction: "unbilled", share: 0, difference };
  const share = Math.abs(difference) / actual;
  if (share < 0.0005) return { direction: "same", share: 0, difference };
  return { direction: difference > 0 ? "saved" : "more", share, difference };
}
