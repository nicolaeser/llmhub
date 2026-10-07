import assert from "node:assert/strict";
import test from "node:test";
import { modelEntry } from "@/lib/gateway/core";
import { modelPricing } from "@/lib/gateway/model-pricing";
import {
  clockMinute,
  isTimeZone,
  localMinute,
  minuteClock,
  priceAt,
  scheduleOverlaps,
  windowValid,
} from "@/lib/gateway/price-schedule";
import type { PriceSchedule } from "@/types/gateway";

const day = { cost_input_per_1k: 0.002, cost_output_per_1k: 0.006 };
const night = { start_minute: 22 * 60, end_minute: 6 * 60, cost_input_per_1k: 0.001, cost_output_per_1k: 0.003 };
const lunch = { start_minute: 12 * 60, end_minute: 13 * 60, cost_input_per_1k: 0.004, cost_output_per_1k: 0.012 };

function schedule(timeZone: string): PriceSchedule {
  return { price: day, time_zone: timeZone, windows: [night, lunch] };
}

test("clock strings round-trip through minutes of the day", () => {
  assert.equal(clockMinute("00:00"), 0);
  assert.equal(clockMinute("23:59"), 1439);
  assert.equal(clockMinute("24:00"), null);
  assert.equal(clockMinute("7:30"), null);
  assert.equal(minuteClock(22 * 60 + 5), "22:05");
});

test("price windows bill their own price, including windows past midnight", () => {
  assert.deepEqual(priceAt(schedule("UTC"), new Date("2026-10-06T23:30:00Z")), {
    cost_input_per_1k: 0.001,
    cost_output_per_1k: 0.003,
  });
  assert.deepEqual(priceAt(schedule("UTC"), new Date("2026-10-06T05:59:00Z")).cost_input_per_1k, 0.001);
  assert.deepEqual(priceAt(schedule("UTC"), new Date("2026-10-06T06:00:00Z")), day);
  assert.deepEqual(priceAt(schedule("UTC"), new Date("2026-10-06T12:30:00Z")).cost_input_per_1k, 0.004);
  assert.deepEqual(priceAt({ ...schedule("UTC"), windows: [] }, new Date("2026-10-06T23:30:00Z")), day);
});

test("window times follow the schedule time zone and daylight saving", () => {
  assert.equal(localMinute(new Date("2026-07-01T20:30:00Z"), "Europe/Berlin"), 22 * 60 + 30);
  assert.equal(localMinute(new Date("2026-12-01T20:30:00Z"), "Europe/Berlin"), 21 * 60 + 30);
  assert.deepEqual(priceAt(schedule("Europe/Berlin"), new Date("2026-07-01T20:30:00Z")).cost_input_per_1k, 0.001);
  assert.deepEqual(priceAt(schedule("Europe/Berlin"), new Date("2026-12-01T20:30:00Z")), day);
  assert.equal(isTimeZone("Europe/Berlin"), true);
  assert.equal(isTimeZone("UTC"), true);
  assert.equal(isTimeZone("Mars/Olympus"), false);
  assert.equal(isTimeZone(""), false);
});

test("windows must have distinct start and end, valid prices, and must not overlap", () => {
  const window = { start: "22:00", end: "06:00", priceInput: 0.001, priceOutput: 0.003 };
  assert.equal(windowValid(window), true);
  assert.equal(windowValid({ ...window, end: "22:00" }), false);
  assert.equal(windowValid({ ...window, start: "" }), false);
  assert.equal(windowValid({ ...window, priceInput: -1 }), false);
  assert.equal(windowValid({ ...window, priceOutput: Number.NaN }), false);
  assert.equal(scheduleOverlaps([window, { ...window, start: "06:00", end: "22:00" }]), false);
  assert.equal(scheduleOverlaps([window, { ...window, start: "05:00", end: "07:00" }]), true);
  assert.equal(scheduleOverlaps([window, { ...window, start: "23:00", end: "23:30" }]), true);
  assert.equal(scheduleOverlaps([{ ...window, start: "01:00", end: "02:00" }, window]), true);
});

test("/v1/models pricing is OpenRouter-style USD per token and only shown when the price is known", () => {
  const at = new Date("2026-10-06T23:30:00Z");
  const routed = [{ kind: "openai", cost_input_per_1k: 0.0025, cost_output_per_1k: 0.01 }];
  assert.deepEqual(modelPricing({ billing_mode: "routed", schedule: schedule("UTC"), deployments: routed }, at), {
    prompt: "0.0000025",
    completion: "0.00001",
  });
  const mixed = [...routed, { kind: "openai", cost_input_per_1k: 0.003, cost_output_per_1k: 0.01 }];
  assert.equal(modelPricing({ billing_mode: "average", schedule: schedule("UTC"), deployments: mixed }, at), null);
  const reported = [{ kind: "openrouter", cost_input_per_1k: 0.0025, cost_output_per_1k: 0.01 }];
  assert.equal(modelPricing({ billing_mode: "routed", schedule: schedule("UTC"), deployments: reported }, at), null);
  const unpriced = [{ kind: "openai_compat", cost_input_per_1k: 0, cost_output_per_1k: 0 }];
  assert.equal(modelPricing({ billing_mode: "routed", schedule: schedule("UTC"), deployments: unpriced }, at), null);

  const custom = modelPricing({ billing_mode: "custom", schedule: schedule("UTC"), deployments: reported }, at);
  assert.deepEqual(custom, {
    prompt: "0.000001",
    completion: "0.000003",
    schedule: {
      time_zone: "UTC",
      default: { prompt: "0.000002", completion: "0.000006" },
      windows: [
        { start: "22:00", end: "06:00", prompt: "0.000001", completion: "0.000003" },
        { start: "12:00", end: "13:00", prompt: "0.000004", completion: "0.000012" },
      ],
    },
  });
  const flat = modelPricing({ billing_mode: "custom", schedule: { ...schedule("UTC"), windows: [] }, deployments: [] }, at);
  assert.deepEqual(flat, { prompt: "0.000002", completion: "0.000006" });
  const free = { price: { cost_input_per_1k: 0, cost_output_per_1k: 0 }, time_zone: "UTC", windows: [] };
  assert.deepEqual(modelPricing({ billing_mode: "custom", schedule: free, deployments: [] }, at), {
    prompt: "0",
    completion: "0",
  });
  const entry = modelEntry("own-llama", at, flat);
  assert.equal(entry.object, "model");
  assert.equal(entry.owned_by, "llm-hub");
  assert.deepEqual(entry.pricing, flat);
  assert.equal("pricing" in modelEntry("auto", at, null), false);
});
