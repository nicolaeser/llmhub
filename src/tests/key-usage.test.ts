import assert from "node:assert/strict";
import test from "node:test";
import { accountUsage, barSegments, groupSegments } from "@/app/(app)/providers/_components/key-usage-view";
import { limitGroups } from "@/lib/gateway/upstreams/limit-groups";
import { usageWindows, windowStart, windowUsage } from "@/lib/providers/key-usage-shares";
import type { KeyUsageRow, LimitWindow, SubscriptionLimits } from "@/types/providers";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const iso = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

function window(over: Partial<LimitWindow>): LimitWindow {
  return { scope: "", usedPercent: 0, windowSeconds: 18_000, resetsAt: null, limitReached: false, ...over };
}

function limits(windows: LimitWindow[]): SubscriptionLimits {
  return { plan: "max", windows, credits: null, resetCredits: null, extraUsage: null, fetchedAt: iso(0) };
}

function row(keyId: string, cost: number, over: Partial<KeyUsageRow> = {}): KeyUsageRow {
  return { keyId, upstreamModel: "claude-sonnet-5-5", requests: 1, tokens: 1_000, cost, ...over };
}

test("windowStart counts back from the reset and falls back to the window length", () => {
  assert.equal(windowStart({ resetsAt: iso(2), windowSeconds: 18_000 }, NOW), NOW - 3 * HOUR);
  assert.equal(windowStart({ resetsAt: null, windowSeconds: 18_000 }, NOW), NOW - 5 * HOUR);
  assert.equal(windowStart({ resetsAt: iso(-1), windowSeconds: 18_000 }, NOW), NOW - 5 * HOUR);
  assert.equal(windowStart({ resetsAt: iso(2), windowSeconds: 0 }, NOW), null);
});

test("usageWindows maps plan and scoped limit groups to their starts", () => {
  const plan = limits([
    window({ usedPercent: 40, resetsAt: iso(1) }),
    window({ usedPercent: 20, windowSeconds: 604_800, resetsAt: iso(48) }),
    window({ scope: "opus", usedPercent: 10, windowSeconds: 604_800, resetsAt: iso(48) }),
  ]);
  const windows = usageWindows("claude", plan, NOW);
  assert.deepEqual(
    windows.map((item) => [item.since, item.scopes]),
    [
      [NOW - 4 * HOUR, null],
      [NOW - 120 * HOUR, null],
      [NOW - 120 * HOUR, ["opus"]],
    ],
  );
});

test("windowUsage splits by cost, then tokens, then requests", () => {
  const since = NOW - HOUR;
  const byCost = windowUsage({ groupId: "plan", since, scopes: null }, [
    row("a", 3),
    row("b", 1, { requests: 4 }),
    row("a", 0, { upstreamModel: "claude-opus-5-5" }),
  ]);
  assert.equal(byCost.basis, "cost");
  assert.equal(byCost.requests, 6);
  assert.deepEqual(
    byCost.keys.map((key) => [key.keyId, key.share, key.requests]),
    [
      ["a", 0.75, 2],
      ["b", 0.25, 4],
    ],
  );

  const byTokens = windowUsage({ groupId: "plan", since, scopes: null }, [
    row("a", 0, { tokens: 100 }),
    row("b", 0, { tokens: 300 }),
  ]);
  assert.equal(byTokens.basis, "tokens");
  assert.deepEqual(
    byTokens.keys.map((key) => [key.keyId, key.share]),
    [
      ["b", 0.75],
      ["a", 0.25],
    ],
  );

  const byRequests = windowUsage({ groupId: "plan", since, scopes: null }, [row("a", 0, { tokens: 0 })]);
  assert.equal(byRequests.basis, "requests");
  assert.equal(byRequests.keys[0]?.share, 1);
});

test("scoped windows only count requests for matching models", () => {
  const usage = windowUsage({ groupId: "opus", since: NOW - HOUR, scopes: ["opus"] }, [
    row("a", 5),
    row("b", 1, { upstreamModel: "claude-opus-5-5" }),
  ]);
  assert.deepEqual(
    usage.keys.map((key) => [key.keyId, key.share]),
    [["b", 1]],
  );
});

test("accountUsage scales shares by the live window usage and drops windows that rolled over", () => {
  const plan = limits([
    window({ usedPercent: 60, resetsAt: iso(1) }),
    window({ usedPercent: 20, windowSeconds: 604_800, resetsAt: iso(48) }),
  ]);
  const groups = limitGroups("claude", plan, NOW);
  const [short, week] = groups;
  const view = accountUsage(
    groups,
    {
      id: "acct",
      windows: [
        windowUsage({ groupId: short!.id, since: NOW - 4 * HOUR, scopes: null }, [row("a", 3), row("b", 1)]),
        windowUsage({ groupId: week!.id, since: NOW - 10 * 24 * HOUR, scopes: null }, [row("b", 1)]),
      ],
    },
    NOW,
  );
  assert.equal(view.peak, 60);
  assert.deepEqual(
    view.windows[0]?.slices.map((slice) => [slice.keyId, slice.percent]),
    [
      ["a", 45],
      ["b", 15],
    ],
  );
  assert.equal(view.windows[1]?.usage, null);
  assert.deepEqual(
    view.keys.map((key) => [key.keyId, key.rank]),
    [
      ["a", 0],
      ["b", 1],
    ],
  );
});

test("barSegments groups keys beyond the shades and shows usage without requests", () => {
  const groups = limitGroups("claude", limits([window({ usedPercent: 70, resetsAt: iso(1) })]), NOW);
  const rows = ["a", "b", "c", "d", "e", "f", "g"].map((keyId) => row(keyId, 1));
  const view = accountUsage(
    groups,
    { id: "acct", windows: [windowUsage({ groupId: groups[0]!.id, since: NOW - 4 * HOUR, scopes: null }, rows)] },
    NOW,
  );
  const ranks = new Map(view.keys.map((key) => [key.keyId, key.rank]));
  const segments = barSegments(view.windows[0]!, ranks);
  assert.deepEqual(
    segments.map((segment) => [segment.kind, segment.keyIds.length]),
    [
      ["key", 1],
      ["key", 1],
      ["key", 1],
      ["key", 1],
      ["key", 1],
      ["other", 2],
    ],
  );
  assert.ok(Math.abs(segments.reduce((sum, segment) => sum + segment.percent, 0) - 70) < 1e-9);

  const idle = accountUsage(groups, undefined, NOW);
  assert.deepEqual(
    barSegments(idle.windows[0]!, new Map()).map((segment) => [segment.kind, segment.percent]),
    [["outside", 70]],
  );
});

test("row bars name the top keys of each window, fold the rest, and stay plain without requests", () => {
  const plan = limits([
    window({ usedPercent: 80, resetsAt: iso(1) }),
    window({ usedPercent: 90, windowSeconds: 604_800, resetsAt: iso(48) }),
    window({ scope: "opus", usedPercent: 30, windowSeconds: 604_800, resetsAt: iso(48) }),
  ]);
  const groups = limitGroups("claude", plan, NOW);
  const [short, week, opus] = groups;
  const view = accountUsage(
    groups,
    {
      id: "acct",
      windows: [
        windowUsage({ groupId: short!.id, since: NOW - 4 * HOUR, scopes: null }, [
          row("a", 4),
          row("b", 2),
          row("c", 1),
          row("d", 1),
          row("e", 0.1),
        ]),
        windowUsage({ groupId: week!.id, since: NOW - 48 * HOUR, scopes: null }, [row("e", 9), row("a", 1)]),
      ],
    },
    NOW,
  );
  assert.equal(view.keys[0]?.keyId, "e");
  const segments = groupSegments(view, short!.id, 3);
  assert.deepEqual(
    segments.map((segment) => [segment.kind, segment.id, segment.keyIds, segment.shade]),
    [
      ["key", "a", ["a"], 1],
      ["key", "b", ["b"], 0.72],
      ["key", "c", ["c"], 0.5],
      ["other", "other", ["d", "e"], 0.5],
    ],
  );
  assert.ok(Math.abs(segments.reduce((sum, segment) => sum + segment.percent, 0) - 80) < 1e-9);
  assert.deepEqual(
    groupSegments(view, week!.id, 3).map((segment) => [segment.id, segment.percent]),
    [
      ["e", 81],
      ["a", 9],
    ],
  );
  assert.deepEqual(groupSegments(view, opus!.id, 3), []);
  assert.deepEqual(groupSegments(view, "missing", 3), []);
  assert.deepEqual(groupSegments(accountUsage(groups, undefined, NOW), short!.id, 3), []);
});
