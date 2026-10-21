import assert from "node:assert/strict";
import test from "node:test";
import {
  latestRecovery,
  quotaBottleneckReset,
  quotaExhausted,
  quotaPressure,
} from "@/lib/gateway/routing/quota";
import { accessOf, accountAllowed, isAccountStrategy } from "@/lib/gateway/routing/account-access";
import {
  pickQuotaBalanced,
  pickQuotaExpiring,
  pickQuotaSmart,
  pickRoundRobin,
} from "@/lib/gateway/routing/router";
import { claudeLimits } from "@/lib/gateway/upstreams/subscription-limits";
import type { Principal } from "@/types/gateway";
import type { Deployment, QuotaScores } from "@/types/routing";
import type { VirtualKeyView } from "@/types/keys";
import type { LimitWindow, SubscriptionLimits } from "@/types/providers";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const iso = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function window(over: Partial<LimitWindow>): LimitWindow {
  return { scope: "", usedPercent: 0, windowSeconds: 18_000, resetsAt: null, limitReached: false, ...over };
}

function limits(windows: LimitWindow[]): SubscriptionLimits {
  return { plan: "max", windows, credits: null, resetCredits: null, extraUsage: null, fetchedAt: iso(0) };
}

function deployment(id: string, weight = 1): Deployment {
  return {
    id,
    kind: "claude",
    base_url: "",
    model: "claude-opus-4",
    weight,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: id,
  };
}

test("an account is exhausted once a plan wide window is full and has not reset yet", () => {
  const full = limits([window({ usedPercent: 100, limitReached: true, resetsAt: iso(2) })]);
  assert.equal(quotaExhausted(full, "claude-opus-4", NOW), true);
  assert.equal(quotaExhausted(full, "claude-opus-4", NOW + 3 * 3_600_000), false);
  assert.equal(quotaExhausted(limits([window({ usedPercent: 99 })]), "claude-opus-4", NOW), false);
  assert.equal(quotaExhausted(null, "claude-opus-4", NOW), false);
});

test("model scoped windows only count for the model they name", () => {
  const opusFull = limits([
    window({ usedPercent: 10 }),
    window({ scope: "Opus", usedPercent: 100, limitReached: true, resetsAt: iso(30) }),
  ]);
  assert.equal(quotaExhausted(opusFull, "claude-opus-4", NOW), true);
  assert.equal(quotaExhausted(opusFull, "claude-sonnet-4-5", NOW), false);
  assert.equal(quotaExhausted(opusFull, "", NOW), false);
  assert.equal(quotaPressure(opusFull, "claude-sonnet-4-5", NOW), 10);
  assert.equal(quotaPressure(opusFull, "claude-opus-4", NOW), 100);
});

test("a window label never changes which models a scoped window covers", () => {
  const labelled = limits([
    window({ scope: "gemini-3-flash", label: "Claude Opus 4.6", usedPercent: 100, limitReached: true, resetsAt: iso(2) }),
  ]);
  assert.equal(quotaExhausted(labelled, "gemini-3-flash", NOW), true);
  assert.equal(quotaExhausted(labelled, "claude-opus-4-6", NOW), false);
  assert.equal(quotaExhausted(labelled, "", NOW), false);
  assert.equal(quotaPressure(labelled, "claude-opus-4-6", NOW), 50);
});

test("pressure is the tightest live window and a renewed window counts as empty", () => {
  const mixed = limits([
    window({ usedPercent: 30, resetsAt: iso(1) }),
    window({ usedPercent: 80, windowSeconds: 604_800, resetsAt: iso(48) }),
  ]);
  assert.equal(quotaPressure(mixed, "m", NOW), 80);
  assert.equal(quotaPressure(mixed, "m", NOW + 49 * 3_600_000), 0);
  assert.equal(quotaPressure(null, "m", NOW), 50);
  assert.equal(quotaPressure(limits([]), "m", NOW), 50);
});

test("the bottleneck reset follows the tightest window", () => {
  const mixed = limits([
    window({ usedPercent: 30, resetsAt: iso(1) }),
    window({ usedPercent: 80, windowSeconds: 604_800, resetsAt: iso(48) }),
  ]);
  assert.equal(quotaBottleneckReset(mixed, "m", NOW), NOW + 48 * 3_600_000);
  assert.equal(quotaBottleneckReset(limits([window({ usedPercent: 0 })]), "m", NOW), Infinity);
  assert.equal(quotaBottleneckReset(null, "m", NOW), Infinity);
});

test("recovery waits for every full plan wide window to reset", () => {
  const full = limits([
    window({ usedPercent: 100, limitReached: true, resetsAt: iso(3) }),
    window({ usedPercent: 100, limitReached: true, windowSeconds: 604_800, resetsAt: iso(40) }),
    window({ scope: "Opus", usedPercent: 100, limitReached: true, resetsAt: iso(1) }),
  ]);
  assert.equal(latestRecovery(full, NOW), NOW + 40 * 3_600_000);
  assert.equal(
    latestRecovery(
      limits([
        window({ usedPercent: 100, limitReached: true, resetsAt: iso(3) }),
        window({ usedPercent: 100, limitReached: true, windowSeconds: 604_800 }),
      ]),
      NOW,
    ),
    null,
  );
  assert.equal(latestRecovery(limits([window({ usedPercent: 10 })]), NOW), null);
});

test("round robin rotates through the same accounts in a stable order", () => {
  const cursors = new Map<string, number>();
  const accounts = [deployment("b"), deployment("a"), deployment("c")];
  const order = Array.from({ length: 6 }, () => pickRoundRobin(accounts, cursors).id);
  assert.deepEqual(order, ["a", "b", "c", "a", "b", "c"]);
  assert.equal(pickRoundRobin([deployment("a"), deployment("b")], cursors).id, "a");
});

test("quota balanced prefers the account with the most headroom, then load, then weight", () => {
  const scores: QuotaScores = new Map([
    ["a", { pressure: 70, reset: Infinity }],
    ["b", { pressure: 20, reset: Infinity }],
    ["c", { pressure: 20, reset: Infinity }],
  ]);
  const busy = new Map([["b", 2]]);
  assert.equal(pickQuotaBalanced([deployment("a"), deployment("b"), deployment("c")], scores, busy).id, "c");
  assert.equal(pickQuotaBalanced([deployment("a"), deployment("b", 5), deployment("c")], scores, new Map()).id, "b");
  assert.equal(pickQuotaBalanced([deployment("a"), deployment("z")], scores, new Map()).id, "z");
});

test("quota expiring spends the account whose tightest limit renews first", () => {
  const scores: QuotaScores = new Map([
    ["a", { pressure: 10, reset: NOW + 5 * 3_600_000 }],
    ["b", { pressure: 60, reset: NOW + 1 * 3_600_000 }],
    ["c", { pressure: 5, reset: Infinity }],
  ]);
  assert.equal(pickQuotaExpiring([deployment("a"), deployment("b"), deployment("c")], scores, new Map()).id, "b");
  assert.equal(pickQuotaExpiring([deployment("a"), deployment("c")], scores, new Map()).id, "a");
  const tied: QuotaScores = new Map([
    ["x", { pressure: 40, reset: NOW }],
    ["y", { pressure: 10, reset: NOW }],
  ]);
  assert.equal(pickQuotaExpiring([deployment("x"), deployment("y")], tied, new Map()).id, "y");
});

test("Claude usage keeps every window, the extra usage budget, and new model limits", () => {
  const result = claudeLimits(
    {
      five_hour: { utilization: 20, resets_at: iso(2) },
      seven_day: { utilization: 55, resets_at: iso(70) },
      seven_day_opus: { utilization: 90, resets_at: iso(70) },
      seven_day_oauth_apps: { utilization: 3, resets_at: null },
      seven_day_cowork: { utilization: 4, resets_at: null },
      iguana_necktie: { utilization: 8, resets_at: iso(70), limit_dollars: 50 },
      limits: [
        { kind: "weekly_scoped", percent: 66, resets_at: iso(70), scope: { model: { display_name: "Opus" } } },
        { kind: "weekly_scoped", percent: 12, resets_at: iso(70), scope: { model: { display_name: "Haiku 5" } } },
        { kind: "five_hour", percent: 1 },
      ],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25 },
    },
    "max_20x",
    NOW,
  );
  assert.deepEqual(
    result.windows.map((entry) => [entry.scope, entry.windowSeconds]),
    [
      ["", 18_000],
      ["", 604_800],
      ["Opus", 604_800],
      ["OAuth apps", 604_800],
      ["Cowork", 604_800],
      ["Cloud sessions", 0],
      ["Haiku 5", 604_800],
    ],
  );
  assert.deepEqual(result.extraUsage, { usedCents: 1250, limitCents: 5000, percent: 25 });
  assert.equal(claudeLimits({ extra_usage: { is_enabled: false } }, "", NOW).extraUsage, null);
});

test("smart spends quota that is about to reset and protects accounts close to their limit", () => {
  const scores: QuotaScores = new Map([
    ["soon", { pressure: 80, reset: NOW + 1 * 3_600_000 }],
    ["roomy", { pressure: 10, reset: NOW + 100 * 3_600_000 }],
    ["full", { pressure: 95, reset: NOW + 0.5 * 3_600_000 }],
  ]);
  const all = [deployment("soon"), deployment("roomy"), deployment("full")];
  assert.equal(pickQuotaSmart(all, scores, new Map(), NOW).id, "soon");
  assert.equal(pickQuotaSmart([deployment("roomy"), deployment("full")], scores, new Map(), NOW).id, "roomy");
  assert.equal(pickQuotaSmart([deployment("full")], scores, new Map(), NOW).id, "full");
  const busy = new Map([["soon", 30]]);
  assert.equal(pickQuotaSmart(all, scores, busy, NOW).id, "roomy");
});

test("smart treats unknown limits as average and breaks ties by load, then weight", () => {
  const unknown: QuotaScores = new Map();
  assert.equal(pickQuotaSmart([deployment("a"), deployment("b", 5)], unknown, new Map(), NOW).id, "b");
  assert.equal(pickQuotaSmart([deployment("a"), deployment("b", 5)], unknown, new Map([["b", 1]]), NOW).id, "a");
  assert.throws(() => pickQuotaSmart([], unknown, new Map(), NOW));
});

test("account strategies are validated by name", () => {
  for (const name of ["inherit", "smart", "quota_balanced", "quota_expiring", "round_robin", "priority", "least_inflight"]) {
    assert.equal(isAccountStrategy(name), true, name);
  }
  assert.equal(isAccountStrategy("cost_lowest"), false);
  assert.equal(isAccountStrategy(""), false);
});

test("account access follows the caller's company, department, project, person, and key", () => {
  const none = { orgId: null, teamId: null, projectId: null, memberId: null, keyId: null };
  const key = { token_id: "key-1", project_id: "proj-1" } as VirtualKeyView;
  const caller: Principal = {
    actor: "key-1",
    key,
    orgId: "org-1",
    teamId: "team-1",
    userId: "",
    memberId: "mem-1",
    models: [],
    routeLimits: {},
  };
  const access = accessOf(caller);
  assert.deepEqual(access, { orgId: "org-1", teamId: "team-1", projectId: "proj-1", memberId: "mem-1", keyId: "key-1" });
  assert.equal(accessOf({ ...caller, key: undefined }), null);
  assert.equal(accessOf(undefined), null);
  assert.equal(accountAllowed({ restricted: false, assignments: [] }, null), true);
  assert.equal(accountAllowed(null, null), true);
  assert.equal(accountAllowed({ restricted: true, assignments: [] }, access), false);
  assert.equal(accountAllowed({ restricted: true, assignments: [{ ...none, keyId: "key-1" }] }, null), false);
  assert.equal(accountAllowed({ restricted: true, assignments: [{ ...none, keyId: "key-2" }] }, access), false);
  for (const hit of [{ keyId: "key-1" }, { memberId: "mem-1" }, { projectId: "proj-1" }, { teamId: "team-1" }, { orgId: "org-1" }]) {
    assert.equal(accountAllowed({ restricted: true, assignments: [{ ...none, ...hit }] }, access), true, JSON.stringify(hit));
  }
  const unbound = { orgId: "", teamId: "", projectId: "", memberId: "", keyId: "key-1" };
  assert.equal(accountAllowed({ restricted: true, assignments: [{ ...none, orgId: "org-1" }] }, unbound), false);
});
