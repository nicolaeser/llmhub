import assert from "node:assert/strict";
import test from "node:test";
import { priceAt } from "@/lib/gateway/price-schedule";
import {
  addMinutes,
  compareCost,
  expectedRates,
  flatCost,
  meanRates,
  scheduleCost,
  targetCost,
  zonedMinute,
} from "@/lib/gateway/what-if";
import type { PriceSchedule } from "@/types/gateway";
import type { MinuteTokens, TrafficTotals } from "@/types/what-if";

const cheap = { cost_input_per_1k: 0.001, cost_output_per_1k: 0.002, weight: 1 };
const pricey = { cost_input_per_1k: 0.01, cost_output_per_1k: 0.03, weight: 3 };
const unpriced = { cost_input_per_1k: 0, cost_output_per_1k: 0, weight: 9 };

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

function minutesOf(rows: { at: string; prompt: number; completion: number }[]): MinuteTokens[] {
  const buckets = new Map<number, MinuteTokens>();
  addMinutes(
    buckets,
    rows.map((row) => ({ createdAt: new Date(row.at), promptTokens: row.prompt, completionTokens: row.completion })),
  );
  return [...buckets.values()];
}

function totalsOf(minutes: MinuteTokens[], cost = 0): TrafficTotals {
  return {
    requests: minutes.length,
    prompt: minutes.reduce((sum, row) => sum + row.prompt, 0),
    completion: minutes.reduce((sum, row) => sum + row.completion, 0),
    cost,
  };
}

test("expected rates follow the routing strategy and skip unpriced deployments", () => {
  assert.deepEqual(expectedRates("cost_lowest", [pricey, unpriced, cheap]), {
    cost_input_per_1k: 0.001,
    cost_output_per_1k: 0.002,
  });
  assert.deepEqual(expectedRates("priority", [cheap, pricey, unpriced]), {
    cost_input_per_1k: 0.01,
    cost_output_per_1k: 0.03,
  });
  const weighted = expectedRates("weighted_random", [cheap, pricey]);
  near(weighted?.cost_input_per_1k ?? 0, (0.001 + 0.01 * 3) / 4);
  near(weighted?.cost_output_per_1k ?? 0, (0.002 + 0.03 * 3) / 4);
  const mean = expectedRates("least_inflight", [cheap, pricey, unpriced]);
  near(mean?.cost_input_per_1k ?? 0, 0.0055);
  near(mean?.cost_output_per_1k ?? 0, 0.016);
  assert.equal(expectedRates("least_inflight", [unpriced]), null);
  assert.equal(meanRates([]), null);
});

test("flat prices reprice prompt and completion tokens per thousand", () => {
  near(flatCost({ cost_input_per_1k: 0.002, cost_output_per_1k: 0.006 }, 1500, 500), 0.006);
});

test("zoned minutes follow the time zone offset and daylight saving time", () => {
  const summer = Math.floor(Date.parse("2026-07-01T21:30:00Z") / 60_000);
  const winter = Math.floor(Date.parse("2026-01-15T21:30:00Z") / 60_000);
  assert.equal(zonedMinute("UTC")(summer), 21 * 60 + 30);
  assert.equal(zonedMinute("Europe/Berlin")(summer), 23 * 60 + 30);
  assert.equal(zonedMinute("Europe/Berlin")(winter), 22 * 60 + 30);
  assert.equal(zonedMinute("Asia/Kolkata")(summer), 3 * 60);
  assert.equal(zonedMinute("America/New_York")(Math.floor(Date.parse("2026-07-01T02:15:00Z") / 60_000)), 22 * 60 + 15);
});

test("price windows reprice each minute at the window price of its local time", () => {
  const schedule: PriceSchedule = {
    price: { cost_input_per_1k: 0.002, cost_output_per_1k: 0.006 },
    time_zone: "Europe/Berlin",
    windows: [{ start_minute: 22 * 60, end_minute: 6 * 60, cost_input_per_1k: 0.001, cost_output_per_1k: 0.003 }],
  };
  const rows = [
    { at: "2026-07-01T21:30:00Z", prompt: 1000, completion: 1000 },
    { at: "2026-07-01T21:30:40Z", prompt: 1000, completion: 0 },
    { at: "2026-01-15T20:30:00Z", prompt: 2000, completion: 1000 },
    { at: "2026-07-01T10:00:00Z", prompt: 3000, completion: 2000 },
  ];
  const minutes = minutesOf(rows);
  assert.equal(minutes.length, 3);
  const expected = rows.reduce((sum, row) => {
    const rates = priceAt(schedule, new Date(row.at));
    return sum + flatCost(rates, row.prompt, row.completion);
  }, 0);
  near(scheduleCost(schedule, totalsOf(minutes), minutes), expected);
  near(expected, 0.001 * 2 + 0.003 + 0.002 * 2 + 0.006 + 0.002 * 3 + 0.006 * 2);
});

test("schedules without windows use the totals and ignore minute buckets", () => {
  const schedule: PriceSchedule = {
    price: { cost_input_per_1k: 0.002, cost_output_per_1k: 0.006 },
    time_zone: "UTC",
    windows: [],
  };
  near(scheduleCost(schedule, { requests: 2, prompt: 4000, completion: 1000, cost: 0 }, []), 0.014);
});

test("average billing never undercuts the group mean", () => {
  const traffic = { requests: 1, prompt: 1000, completion: 1000, cost: 0 };
  const routed = { cost_input_per_1k: 0.001, cost_output_per_1k: 0.002 };
  const floor = { cost_input_per_1k: 0.004, cost_output_per_1k: 0.004 };
  const price = { schedule: { price: routed, time_zone: "UTC", windows: [] }, floor };
  near(targetCost(price, traffic, []), 0.008);
  near(targetCost({ ...price, floor: null }, traffic, []), 0.003);
});

test("cost comparison reports the share saved or added against billed spend", () => {
  const saved = compareCost(10, 6.2);
  assert.equal(saved.direction, "saved");
  near(saved.share, 0.38);
  near(saved.difference, 3.8);
  const more = compareCost(10, 12.5);
  assert.equal(more.direction, "more");
  near(more.share, 0.25);
  assert.equal(compareCost(10, 10.001).direction, "same");
  assert.equal(compareCost(0, 4).direction, "unbilled");
});
