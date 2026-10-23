import assert from "node:assert/strict";
import test from "node:test";
import { countdown, exhaustionAt, nearReset } from "@/app/(app)/providers/_components/limit-timing";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK_SECONDS = 604_800;
const FIVE_HOURS_SECONDS = 18_000;

function weekly(usedPercent: number, resetIn: number, over: { limitReached?: boolean; windowSeconds?: number } = {}) {
  return {
    usedPercent,
    resetsAt: new Date(NOW + resetIn).toISOString(),
    windowSeconds: WEEK_SECONDS,
    limitReached: false,
    ...over,
  };
}

test("countdowns pick the largest unit and keep the next one", () => {
  assert.deepEqual(countdown(2 * DAY + 9 * HOUR + 59 * MINUTE + 30_000), { unit: "days", days: 2, hours: 10, minutes: 0 });
  assert.deepEqual(countdown(DAY + 5 * MINUTE), { unit: "days", days: 1, hours: 0, minutes: 5 });
  assert.deepEqual(countdown(HOUR + 40 * MINUTE), { unit: "hours", days: 0, hours: 1, minutes: 40 });
  assert.deepEqual(countdown(7 * MINUTE - 1), { unit: "minutes", days: 0, hours: 0, minutes: 7 });
});

test("countdowns never show zero minutes for a reset that is still ahead", () => {
  assert.deepEqual(countdown(1_000), { unit: "minutes", days: 0, hours: 0, minutes: 1 });
  assert.deepEqual(countdown(0), { unit: "minutes", days: 0, hours: 0, minutes: 1 });
});

test("resets within six days count as near", () => {
  assert.equal(nearReset(NOW + 5 * DAY, NOW), true);
  assert.equal(nearReset(NOW + 6 * DAY, NOW), false);
});

test("a weekly limit used faster than time passes runs out before its reset", () => {
  const resetIn = 2 * DAY + 9 * HOUR;
  const elapsed = 7 * DAY - resetIn;
  const at = exhaustionAt(weekly(90, resetIn), NOW);
  assert.equal(at, NOW - elapsed + (elapsed * 100) / 90);
  assert.ok(at !== null && at < NOW + resetIn);
});

test("a weekly limit on pace, below it, or running out just before the reset has no exhaustion time", () => {
  assert.equal(exhaustionAt(weekly(50, 3.5 * DAY), NOW), null);
  assert.equal(exhaustionAt(weekly(10, 2 * DAY), NOW), null);
  assert.equal(exhaustionAt(weekly(70, 2 * DAY + 8 * HOUR), NOW), null);
});

test("pace stays quiet early in a window, for short windows, and once the limit is reached", () => {
  assert.equal(exhaustionAt(weekly(40, 6 * DAY), NOW), null);
  assert.equal(exhaustionAt(weekly(80, 2 * HOUR, { windowSeconds: FIVE_HOURS_SECONDS }), NOW), null);
  assert.equal(exhaustionAt(weekly(100, DAY, { limitReached: true }), NOW), null);
  assert.equal(exhaustionAt(weekly(0, DAY), NOW), null);
  assert.equal(exhaustionAt({ ...weekly(90, DAY), resetsAt: null }, NOW), null);
});
