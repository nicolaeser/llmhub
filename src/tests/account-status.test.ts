import assert from "node:assert/strict";
import test from "node:test";
import { accountState, partialLimits, recoveryAt } from "@/app/(app)/providers/_components/account-status";
import type { AccountLimits, LimitWindow, ProviderView } from "@/types/providers";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const iso = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

function provider(kind: string): ProviderView {
  return {
    id: `${kind}-1`,
    name: kind,
    kind,
    baseUrl: "",
    hasApiKey: false,
    enabled: true,
    restricted: false,
    assignments: [],
    signIn: { account: "user@example.test", plan: "pro", status: "active" },
    sharedVia: null,
    manageActive: false,
    discovered: [],
    policy: { zdr: false, retentionDays: null, region: "", noTraining: false },
    vertex: null,
  };
}

function entry(windows: LimitWindow[]): AccountLimits {
  return {
    id: "account",
    error: "",
    limits: { plan: "pro", windows, credits: null, resetCredits: null, extraUsage: null, fetchedAt: iso(0) },
  };
}

function model(scope: string, usedPercent: number, hours: number | null): LimitWindow {
  return {
    scope,
    usedPercent,
    windowSeconds: 0,
    resetsAt: hours === null ? null : iso(hours),
    limitReached: usedPercent >= 100,
  };
}

function plan(usedPercent: number, windowSeconds: number, hours: number): LimitWindow {
  return { scope: "", usedPercent, windowSeconds, resetsAt: iso(hours), limitReached: usedPercent >= 100 };
}

const antigravity = provider("antigravity");
const claude = provider("claude");

test("an antigravity account is limited once every visible group is exhausted", () => {
  const full = entry([
    model("claude-sonnet-4-6", 100, 5),
    model("gemini-3-flash", 100, 2),
    model("gemini-3-pro-high", 100, 9),
    model("gemini-3-pro-low", 100, 7),
    model("gemini-2.5-pro", 10, 1),
    model("chat_20706", 0, null),
  ]);
  assert.equal(accountState(antigravity, full, true, NOW), "limited");
  assert.equal(recoveryAt(antigravity, full, NOW), NOW + 9 * HOUR);
  assert.equal(partialLimits(antigravity, full, NOW), null);
  assert.equal(accountState(antigravity, full, true, NOW + 10 * HOUR), "available");
  assert.equal(recoveryAt(antigravity, entry([model("claude-sonnet-4-6", 100, null)]), NOW), null);
});

test("an antigravity account with some exhausted groups stays available and reports them", () => {
  const some = entry([
    model("claude-sonnet-4-6", 100, 5),
    model("gemini-3-flash", 40, 2),
    model("gemini-3-pro-high", 0, null),
  ]);
  assert.equal(accountState(antigravity, some, true, NOW), "available");
  assert.deepEqual(partialLimits(antigravity, some, NOW), { reached: 1, total: 3 });
  assert.equal(recoveryAt(antigravity, some, NOW), null);
  assert.equal(partialLimits(antigravity, entry([model("gemini-3-flash", 40, 2)]), NOW), null);
});

test("a group with only some models at their limit does not limit the account", () => {
  const split = entry([model("gemini-3-flash", 100, 2), model("gemini-3.8-flash-high", 30, 4)]);
  assert.equal(accountState(antigravity, split, true, NOW), "available");
  assert.deepEqual(partialLimits(antigravity, split, NOW), { reached: 1, total: 1 });
});

test("hidden antigravity models never limit an account", () => {
  const hidden = entry([model("gemini-2.5-pro", 100, 2), model("gemini-2.5-flash-thinking", 100, 2), model("gemini-3-flash", 0, null)]);
  assert.equal(accountState(antigravity, hidden, true, NOW), "available");
  assert.equal(partialLimits(antigravity, hidden, NOW), null);
});

test("plan windows keep deciding accounts that have them", () => {
  const scopedFull = entry([
    plan(20, 18_000, 3),
    plan(50, 604_800, 80),
    { ...model("Opus", 100, 80), windowSeconds: 604_800 },
  ]);
  assert.equal(accountState(claude, scopedFull, true, NOW), "available");
  assert.deepEqual(partialLimits(claude, scopedFull, NOW), { reached: 1, total: 3 });

  const planFull = entry([plan(100, 18_000, 3), plan(100, 604_800, 80), { ...model("Opus", 100, 90), windowSeconds: 604_800 }]);
  assert.equal(accountState(claude, planFull, true, NOW), "limited");
  assert.equal(recoveryAt(claude, planFull, NOW), NOW + 80 * HOUR);
  assert.equal(partialLimits(claude, planFull, NOW), null);

  assert.equal(accountState(claude, entry([]), true, NOW), "available");
  assert.equal(partialLimits(claude, entry([]), NOW), null);
  assert.equal(accountState(claude, undefined, true, NOW), "checking");
  assert.equal(recoveryAt(claude, undefined, NOW), null);
});
