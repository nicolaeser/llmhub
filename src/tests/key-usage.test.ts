import assert from "node:assert/strict";
import test from "node:test";
import {
  accountUsage,
  barParts,
  barSegments,
  barSpans,
  groupSegments,
  type BarPart,
  type BarSegment,
} from "@/app/(app)/providers/_components/key-usage-view";
import { toneHue } from "@/app/(app)/providers/_components/limit-tone";
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

function keySegment(id: string, percent: number, shade = 1): BarSegment {
  return { id, kind: "key", keyIds: [id], percent, shade };
}

function assertFillsTrack(parts: BarPart[]) {
  let edge = 0;
  for (const part of parts) {
    assert.ok(Math.abs(part.start - edge) < 1e-9, `${part.id} starts at ${part.start}, expected ${edge}`);
    assert.ok(part.size > 0, `${part.id} has no width`);
    edge = part.start + part.size;
  }
  assert.equal(edge, 100);
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

test("bar parts sit in segment order with the free remainder last and fill the track exactly", () => {
  const first = barParts([keySegment("a", 4.5)], 4.5);
  assert.deepEqual(
    first.map((part) => part.id),
    ["a", "free"],
  );
  assertFillsTrack(first);

  const grown = barParts([keySegment("a", 4.5), keySegment("b", 1.5, 0.72)], 6);
  assert.deepEqual(
    grown.map((part) => [part.id, part.percent]),
    [
      ["a", 4.5],
      ["b", 1.5],
      ["free", 94],
    ],
  );
  assertFillsTrack(grown);
  assert.equal(grown[0]!.start, 0);
  assert.equal(grown[1]!.start, grown[0]!.size);
  assert.ok(grown[2]!.start < 7);

  const swapped = barParts([keySegment("b", 5, 1), keySegment("a", 4.5, 0.72)], 9.5);
  assert.deepEqual(
    swapped.map((part) => part.id),
    ["b", "a", "free"],
  );
  assertFillsTrack(swapped);

  const full = barParts([keySegment("a", 63), keySegment("b", 37, 0.72)], 100);
  assert.deepEqual(
    full.map((part) => [part.id, part.start, part.size]),
    [
      ["a", 0, 63],
      ["b", 63, 37],
    ],
  );

  const over = barParts([keySegment("a", 78), keySegment("b", 52, 0.72)], 130);
  assert.deepEqual(
    over.map((part) => part.id),
    ["a", "b"],
  );
  assertFillsTrack(over);
  assert.ok(Math.abs(over[0]!.size - 60) < 1e-9);

  const idle = barParts([], 0);
  assert.deepEqual(
    idle.map((part) => [part.id, part.start, part.size]),
    [["free", 0, 100]],
  );
});

test("tiny bar parts keep a visible width without pushing the bar past the track", () => {
  const sliver = barParts([keySegment("a", 0.05)], 0.05);
  assertFillsTrack(sliver);
  assert.equal(sliver[0]!.size, 2);
  assert.equal(sliver[1]!.size, 98);

  const nearlyFull = barParts([keySegment("a", 99.6), keySegment("b", 0.3, 0.72)], 99.9);
  assertFillsTrack(nearlyFull);
  assert.equal(nearlyFull[1]!.size, 2);
  assert.ok(Math.abs(nearlyFull[2]!.size - 2) < 1e-9);
  assert.ok(Math.abs(nearlyFull[0]!.size - 96) < 1e-9);

  const mixed = barParts(
    [keySegment("a", 4.5), keySegment("b", 1.5, 0.72), keySegment("c", 0.4, 0.5), keySegment("d", 0.05, 0.34)],
    6.45,
  );
  assertFillsTrack(mixed);
  assert.deepEqual(
    mixed.slice(1, 4).map((part) => part.size),
    [2, 2, 2],
  );
  assert.ok(mixed[0]!.size > 4 && mixed[0]!.size < 4.5);
  assert.ok(mixed.every((part, index) => index === 0 || part.start >= mixed[index - 1]!.start));

  const crowded = barSpans(Array.from({ length: 80 }, () => 0.05));
  assert.ok(crowded.every((span) => Math.abs(span.size - 1.25) < 1e-9));
  assert.ok(Math.abs(crowded.at(-1)!.start + crowded.at(-1)!.size - 100) < 1e-9);

  assert.deepEqual(barSpans([]), []);
  assert.deepEqual(barSpans([0, Number.NaN, -3]), [
    { start: 0, size: 0 },
    { start: 0, size: 0 },
    { start: 0, size: 0 },
  ]);
  assert.deepEqual(barSpans([0, 5]), [
    { start: 0, size: 0 },
    { start: 0, size: 100 },
  ]);
});

test("split bars take the hue of the limit's tone", () => {
  assert.equal(toneHue("calm"), "var(--accent)");
  assert.equal(toneHue("rising"), "var(--warning)");
  for (const tone of ["near", "full_short", "full_scoped", "full"] as const) {
    assert.equal(toneHue(tone), "var(--danger)");
  }
});
