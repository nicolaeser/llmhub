import assert from "node:assert/strict";
import test from "node:test";
import { claudeWindows } from "@/lib/gateway/upstreams/claude-usage";
import { claudeResetCredits, codexResetCredits, parseClaudeResets, parseCodexCredits } from "@/lib/gateway/upstreams/reset-credits";
import {
  claudeResetOptions,
  pendingOptions,
  pickResetOption,
  RESET_BLOCKER_CODES,
} from "@/lib/gateway/upstreams/reset-options";
import { resetCreditsView } from "@/lib/gateway/upstreams/reset-state";
import type { JsonMap } from "@/types/gateway";
import type { LimitWindow, SubscriptionLimits } from "@/types/providers";
import type { ResetBlocker, ResetOption, ResetState, StoredResetView } from "@/types/resets";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const WEEK_RESET = "2026-11-12T22:00:00.292677+00:00";
const SESSION_RESET = "2026-11-11T15:00:00Z";
const CODENAME = /iguana|necktie|seven_day|five_hour|overage|omelette|cedar|weekly_scoped/;

function weeklyLimit(percent: number): JsonMap {
  return {
    kind: "weekly_all",
    group: "weekly",
    percent,
    severity: percent >= 100 ? "critical" : "normal",
    resets_at: WEEK_RESET,
    scope: null,
    is_active: true,
  };
}

function fableLimit(percent: number): JsonMap {
  return {
    kind: "weekly_scoped",
    group: "weekly",
    percent,
    severity: "normal",
    resets_at: "2026-11-12T22:00:00+00:00",
    scope: { model: { id: null, display_name: "Fable" }, surface: null },
    is_active: false,
  };
}

function usage(weekly: number, fable: number, fableOfWeekly: number, fiveHour: number | null = null): JsonMap {
  return {
    five_hour: fiveHour === null ? null : { utilization: fiveHour, resets_at: SESSION_RESET },
    seven_day: { utilization: weekly, resets_at: WEEK_RESET },
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_omelette: null,
    iguana_necktie: null,
    nimbus_quill: null,
    limits: [weeklyLimit(weekly), fableLimit(fable)],
    weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: fableOfWeekly, allowance_percent_of_weekly: 50 }],
    seven_day_breakdown: { rows: [{ key: "claude_code", display_name: "Claude Code", percent: weekly }] },
  };
}

function grant(id: string, change: JsonMap = {}): JsonMap {
  return {
    id,
    label: `${id} label`,
    resets_total: 1,
    resets_left: 1,
    starts_at: "2026-11-01T00:00:00Z",
    ends_at: "2026-11-30T00:00:00Z",
    usable_now: true,
    ...change,
  };
}

const fableGrant = (change: JsonMap = {}) =>
  grant("fable_1", { clears: ["seven_day_overage_included"], gives_back_weekly: true, ...change });
const weeklyGrant = (change: JsonMap = {}) =>
  grant("weekly_1", { clears: ["seven_day", "seven_day_overage_included"], type: "weekly", ...change });
const fullGrant = (change: JsonMap = {}) =>
  grant("full_1", { clears: ["five_hour", "seven_day", "seven_day_overage_included"], type: "full", ...change });
const sessionGrant = (change: JsonMap = {}) => grant("session_1", { clears: ["five_hour"], type: "session", ...change });

function options(payload: JsonMap, grants: JsonMap[], change: JsonMap = {}, reachedPercent?: number): ResetOption[] {
  const block = parseClaudeResets({ ...payload, cedar_ember: { eligible: true, at_limit: true, grants, ...change } });
  assert.ok(block);
  return claudeResetOptions(block, block.windows, NOW, reachedPercent === undefined ? {} : { reachedPercent }).options;
}

function summary(list: ResetOption[]): Record<string, [ResetBlocker | null, boolean, boolean]> {
  return Object.fromEntries(list.map((item) => [item.id, [item.blocker, item.helpsNow, item.recommended]]));
}

test("the usage payload yields keyed windows and the Fable share of the weekly limit", () => {
  const windows = claudeWindows(usage(100, 0, 0));
  assert.deepEqual(windows, [
    { key: "seven_day", scope: "", usedPercent: 100, windowSeconds: 604_800, resetsAt: "2026-11-12T22:00:00.292Z", limitReached: true },
    {
      key: "weekly_scoped",
      scope: "Fable",
      usedPercent: 0,
      windowSeconds: 604_800,
      resetsAt: "2026-11-12T22:00:00.000Z",
      limitReached: false,
      usedPercentOfWeekly: 0,
      allowancePercentOfWeekly: 50,
    },
  ]);
  const named = claudeWindows({ iguana_necktie: { utilization: 40, resets_at: WEEK_RESET }, limits: [fableLimit(40)] });
  assert.deepEqual(
    named.map((window) => [window.key, window.scope]),
    [["iguana_necktie", "Fable"]],
  );
  assert.deepEqual(claudeWindows({ weekly_scoped_shares: "none", limits: [{ kind: "weekly_scoped" }, null] }), []);
  const unshared = claudeWindows({ limits: [fableLimit(10)], weekly_scoped_shares: [{ limit_index: 4, used_percent_of_weekly: 9 }] });
  assert.equal(unshared[0]?.usedPercentOfWeekly, undefined);
});

test("weekly limit full and Fable unused: the Fable reset is refused and the weekly reset is recommended", () => {
  const list = options(usage(100, 0, 0), [fableGrant(), weeklyGrant()], { next_grant_id: "fable_1", exhausted: ["seven_day"] });
  assert.deepEqual(summary(list), {
    fable_1: ["nothing_to_give_back", false, false],
    weekly_1: [null, true, true],
  });
  const [fable, weekly] = list;
  assert.equal(fable?.family, "scoped");
  assert.equal(fable?.scope, "Fable");
  assert.deepEqual(fable?.givesBack, { scope: "Fable", percentOfWeekly: 0 });
  assert.equal(weekly?.family, "weekly");
  assert.equal(weekly?.givesBack, null);
  assert.deepEqual(
    weekly?.refills.map((limit) => [limit.key, limit.family, limit.scope, limit.usedPercent, limit.limitReached]),
    [
      ["seven_day", "weekly", "", 100, true],
      ["seven_day_overage_included", "scoped", "Fable", 0, false],
    ],
  );
  assert.equal(pickResetOption(list, "", "manual").id, "weekly_1");
  assert.equal(pickResetOption(list, "", "auto").id, "weekly_1");
  assert.throws(() => pickResetOption(list, "fable_1", "manual"), /^Error: RESET_NOTHING_TO_GIVE_BACK$/);
  assert.throws(() => pickResetOption(list, "fable_1", "auto"), /^Error: RESET_NOT_AVAILABLE$/);
  const full = options(usage(100, 0, 0), [fableGrant(), fullGrant()], { next_grant_id: "fable_1" });
  assert.deepEqual(summary(full), { fable_1: ["nothing_to_give_back", false, false], full_1: [null, true, true] });
  assert.equal(full[1]?.family, "full");
});

test("the upstream blocked-by-weekly signal on a gives-back grant means nothing to give back", () => {
  const blind = { seven_day: { utilization: 100, resets_at: WEEK_RESET } };
  assert.equal(options(blind, [fableGrant({ blocking: ["seven_day"], usable_now: false })])[0]?.blocker, "nothing_to_give_back");
  const reasoned = options(blind, [fableGrant({ unavailable_reason: "blocked_seven_day", usable_now: false })])[0];
  assert.equal(reasoned?.blocker, "nothing_to_give_back");
  assert.deepEqual(reasoned?.givesBack, { scope: "Fable", percentOfWeekly: 0 });
  const unknown = options(blind, [fableGrant()])[0];
  assert.deepEqual([unknown?.blocker, unknown?.helpsNow, unknown?.recommended], [null, false, false]);
  assert.deepEqual(unknown?.givesBack, { scope: "Fable", percentOfWeekly: null });
  const zero = options(blind, [fableGrant({ percent_used: { seven_day_overage_included: 0 } })])[0];
  assert.equal(zero?.blocker, "nothing_to_give_back");
  const some = options(blind, [fableGrant({ percent_used: { seven_day_overage_included: 30 } })])[0];
  assert.deepEqual([some?.blocker, some?.helpsNow, some?.recommended], [null, true, true]);
});

test("Fable usage above zero makes the Fable reset spendable next to the weekly reset", () => {
  const list = options(usage(100, 60, 30), [fableGrant(), weeklyGrant()], { next_grant_id: "fable_1" });
  assert.deepEqual(summary(list), { fable_1: [null, true, true], weekly_1: [null, true, false] });
  assert.deepEqual(list[0]?.givesBack, { scope: "Fable", percentOfWeekly: 30 });
  assert.throws(() => pickResetOption(list, "", "manual"), /^Error: RESET_CHOICE_REQUIRED$/);
  assert.equal(pickResetOption(list, "weekly_1", "manual").id, "weekly_1");
  assert.equal(pickResetOption(list, "", "auto").id, "fable_1");
  assert.throws(() => pickResetOption(list, "weekly_1", "auto"), /^Error: RESET_NOT_AVAILABLE$/);
  const byExpiry = options(usage(100, 60, 30), [fableGrant(), weeklyGrant({ ends_at: "2026-11-20T00:00:00Z" })], {
    next_grant_id: null,
  });
  assert.equal(byExpiry.find((item) => item.recommended)?.id, "weekly_1");
  const byId = options(usage(100, 60, 30), [weeklyGrant(), fableGrant()], { next_grant_id: "gone" });
  assert.equal(byId.find((item) => item.recommended)?.id, "fable_1");
  const derived = options({ seven_day: { utilization: 100, resets_at: WEEK_RESET }, limits: [fableLimit(60)] }, [fableGrant()]);
  assert.deepEqual(derived[0]?.givesBack, { scope: "Fable", percentOfWeekly: null });
  assert.equal(derived[0]?.helpsNow, true);
  const fableOnly = options(usage(70, 100, 50), [fableGrant(), weeklyGrant()], { exhausted: ["seven_day_overage_included"] });
  assert.deepEqual(summary(fableOnly), { fable_1: [null, true, true], weekly_1: [null, true, false] });
});

test("a 5-hour reset is refused while the weekly limit it does not refill is full", () => {
  const weeklyOnly = options(usage(100, 0, 0, 40), [sessionGrant(), weeklyGrant()], { next_grant_id: "session_1" });
  assert.deepEqual(summary(weeklyOnly), { session_1: ["other_limit", false, false], weekly_1: [null, true, true] });
  assert.equal(weeklyOnly[0]?.family, "five_hour");
  assert.throws(() => pickResetOption(weeklyOnly, "session_1", "manual"), /^Error: RESET_OTHER_LIMIT$/);
  const both = options(usage(100, 0, 0, 100), [sessionGrant(), weeklyGrant(), fullGrant()], { next_grant_id: "session_1" });
  assert.deepEqual(summary(both), {
    session_1: ["other_limit", false, false],
    weekly_1: ["other_limit", false, false],
    full_1: [null, true, true],
  });
  const sessionOnly = options(usage(40, 0, 0, 100), [sessionGrant(), weeklyGrant()], { next_grant_id: "weekly_1" });
  assert.deepEqual(summary(sessionOnly), { session_1: [null, true, true], weekly_1: ["other_limit", false, false] });
  const upstream = options(usage(40, 0, 0, 100), [sessionGrant({ blocking: ["seven_day_opus"], usable_now: false })]);
  assert.equal(upstream[0]?.blocker, "other_limit");
  for (const reason of ["blocked_five_hour", "blocked_opus", "blocked_sonnet", "blocked_other", "cannot_clear"]) {
    assert.equal(options(usage(40, 0, 0, 100), [sessionGrant({ unavailable_reason: reason })])[0]?.blocker, "other_limit", reason);
  }
});

test("each reason a grant cannot be spent maps to one blocker and its own error code", () => {
  const atSession = usage(40, 0, 0, 100);
  const blocked = (change: JsonMap, block: JsonMap = {}, payload = atSession) => options(payload, [sessionGrant(change)], block)[0]?.blocker;
  assert.equal(blocked({}), null);
  assert.equal(blocked({}, { eligible: false, ineligible_reason: "tier" }), "ineligible");
  assert.equal(blocked({}, { cooldown_until: "2026-11-11T13:00:00Z" }), "cooldown");
  assert.equal(blocked({}, { cooldown_until: "2026-11-11T11:00:00Z" }), null);
  assert.equal(blocked({ unavailable_reason: "cooldown" }), "cooldown");
  assert.equal(blocked({ paused: true }), "paused");
  assert.equal(blocked({ starts_at: "2026-11-12T00:00:00Z" }), "not_started");
  assert.equal(blocked({ resets_left: 0 }), "exhausted");
  assert.equal(blocked({ usable_now: false }), "not_usable");
  assert.equal(blocked({ unavailable_reason: "unavailable" }), "not_usable");
  assert.equal(blocked({ unavailable_reason: "something_new" }), "not_usable");
  assert.equal(blocked({ unavailable_reason: "needs_limit" }), "needs_limit");
  assert.equal(blocked({}, { at_limit: false }, usage(40, 0, 0, 30)), "needs_limit");
  assert.equal(blocked({}, { at_limit: false }), "needs_limit");
  assert.equal(blocked({}, {}, usage(40, 0, 0, 30)), "needs_limit");
  assert.equal(blocked({ use_requires_limit: false }, { at_limit: false }, usage(40, 0, 0, 30)), null);
  assert.equal(options(atSession, [sessionGrant({ ends_at: "2026-11-11T11:59:59Z" })]).length, 0);
  const codes = Object.values(RESET_BLOCKER_CODES);
  assert.equal(new Set(codes).size, codes.length);
  for (const [blocker, code] of Object.entries(RESET_BLOCKER_CODES)) {
    const option = { ...options(atSession, [sessionGrant()])[0]!, blocker: blocker as ResetBlocker };
    assert.throws(() => pickResetOption([option], option.id, "manual"), new RegExp(`^Error: ${code}$`));
    assert.throws(() => pickResetOption([option], "", "manual"), new RegExp(`^Error: ${code}$`));
    assert.match(code, /^RESET_[A-Z_]+$/);
  }
});

test("an early-use grant can be spent by hand but never helps and is never recommended", () => {
  const early = options(usage(40, 10, 5, 30), [fullGrant({ use_requires_limit: false })], { at_limit: false });
  assert.deepEqual(summary(early), { full_1: [null, false, false] });
  assert.equal(pickResetOption(early, "", "manual").id, "full_1");
  assert.throws(() => pickResetOption(early, "", "auto"), /^Error: RESET_NOT_AVAILABLE$/);
  const lens = options(usage(96, 10, 5, 30), [fullGrant({ use_requires_limit: false }), sessionGrant({ use_requires_limit: false })], { at_limit: false }, 95);
  assert.deepEqual(summary(lens), { full_1: [null, true, true], session_1: ["other_limit", false, false] });
  const bound = options(usage(96, 10, 5, 30), [fullGrant()], { at_limit: false }, 95);
  assert.deepEqual(summary(bound), { full_1: ["needs_limit", true, false] });
});

test("a single spendable reset needs no choice and several refuse a redeem without one", () => {
  const one = options(usage(100, 0, 0), [weeklyGrant()]);
  assert.equal(pickResetOption(one, "", "manual").id, "weekly_1");
  assert.equal(pickResetOption(one, "weekly_1", "manual").id, "weekly_1");
  assert.throws(() => pickResetOption(one, "missing", "manual"), /^Error: RESET_NOT_AVAILABLE$/);
  assert.throws(() => pickResetOption([], "", "manual"), /^Error: RESET_NOT_AVAILABLE$/);
  assert.throws(() => pickResetOption([], "", "auto"), /^Error: RESET_NOT_AVAILABLE$/);
  const two = options(usage(100, 0, 0), [weeklyGrant(), fullGrant()]);
  assert.throws(() => pickResetOption(two, "", "manual"), /^Error: RESET_CHOICE_REQUIRED$/);
  const mixed = options(usage(100, 0, 0, 40), [sessionGrant(), fableGrant()]);
  assert.deepEqual(summary(mixed), { session_1: ["other_limit", false, false], fable_1: ["nothing_to_give_back", false, false] });
  assert.throws(() => pickResetOption(mixed, "", "manual"), /^Error: RESET_NOT_AVAILABLE$/);
});

test("no upstream codename reaches a scope or a label, and unknown windows stay visible as other", () => {
  const payload = { ...usage(100, 20, 10, 100), seven_day_opus: { utilization: 5, resets_at: WEEK_RESET } };
  const block = parseClaudeResets({
    ...payload,
    cedar_ember: {
      eligible: true,
      at_limit: true,
      grants: [
        fullGrant({ clears: ["five_hour", "seven_day", "seven_day_overage_included", "seven_day_opus", "seven_day_omelette", "brand_new_window"] }),
        fableGrant(),
        grant("opus_1", { clears: ["seven_day_opus", "seven_day_sonnet"] }),
        grant("typed_1", { type: "session" }),
      ],
    },
  });
  assert.ok(block);
  const credits = claudeResetCredits(block, NOW);
  const shown = [
    ...credits.limits!.map((limit) => limit.scope),
    ...credits.options!.flatMap((item) => [item.scope, item.givesBack?.scope ?? "", ...item.refills.map((limit) => limit.scope)]),
  ];
  for (const text of shown) assert.doesNotMatch(text, CODENAME);
  assert.deepEqual(
    credits.limits!.map((limit) => [limit.key, limit.family, limit.scope]),
    [
      ["five_hour", "five_hour", ""],
      ["seven_day", "weekly", ""],
      ["seven_day_opus", "scoped", "Opus"],
      ["seven_day_overage_included", "scoped", "Fable"],
    ],
  );
  const [full, , opus, typed] = credits.options!;
  assert.deepEqual(
    full?.refills.map((limit) => [limit.family, limit.scope]),
    [
      ["five_hour", ""],
      ["weekly", ""],
      ["scoped", "Fable"],
      ["scoped", "Opus"],
      ["other", ""],
      ["other", ""],
    ],
  );
  assert.equal(full?.family, "full");
  assert.deepEqual([opus?.family, opus?.scope, opus?.blocker], ["scoped", "Opus, Sonnet", "other_limit"]);
  assert.deepEqual([typed?.family, typed?.refills.length, typed?.blocker], ["five_hour", 0, "other_limit"]);
  assert.equal(credits.options!.every((item) => item.movesWeeklyResetDay === false), true);
  assert.equal("claude" in credits, false);
  const pool = claudeResetCredits(
    parseClaudeResets({
      five_hour: { utilization: 100, resets_at: SESSION_RESET },
      iguana_necktie: { utilization: 100, limit_dollars: 50 },
      limits: [{ kind: "weekly_scoped", percent: 100, resets_at: WEEK_RESET, scope: { model: { display_name: "Haiku 5" } } }],
      cedar_ember: { eligible: true, at_limit: true, grants: [fullGrant()] },
    })!,
    NOW,
  );
  assert.deepEqual(
    pool.limits!.map((limit) => [limit.key, limit.family, limit.scope]),
    [
      ["five_hour", "five_hour", ""],
      ["pool_cloudsessions", "other", "Cloud sessions"],
      ["seven_day_overage_included", "scoped", "Haiku 5"],
    ],
  );
  assert.deepEqual([pool.options![0]?.blocker, pool.options![0]?.helpsNow], [null, true]);
});

test("a window whose reset has passed no longer counts as reached, whatever the grant block still lists", () => {
  const stale = { seven_day: { utilization: 100, resets_at: "2026-11-11T11:00:00Z" } };
  const list = options(stale, [weeklyGrant()], { exhausted: ["seven_day"] });
  assert.deepEqual(summary(list), { weekly_1: ["needs_limit", false, false] });
  const listed = options({}, [weeklyGrant()], { exhausted: ["seven_day"] });
  assert.deepEqual(summary(listed), { weekly_1: [null, true, true] });
  assert.deepEqual(listed[0]?.refills[0], {
    key: "seven_day",
    family: "weekly",
    scope: "",
    usedPercent: null,
    limitReached: true,
    resetsAt: null,
  });
  const blind = options({}, [weeklyGrant()]);
  assert.deepEqual(summary(blind), { weekly_1: [null, false, false] });
});

test("Codex credits become full options and the soonest expiry is recommended while a plan limit is reached", () => {
  const list = parseCodexCredits({
    credits: [
      { id: "late", reset_type: "codex_rate_limits", status: "available", expires_at: "2026-12-30T00:00:00Z", title: "Bonus" },
      { id: "soon", reset_type: "codex_rate_limits", status: "available", expires_at: "2026-11-20T00:00:00Z", title: "Launch" },
      { id: "spent", status: "redeemed", expires_at: "2026-11-20T00:00:00Z" },
      { id: "expired", status: "available", expires_at: "2026-11-01T00:00:00Z" },
    ],
  });
  const window = (windowSeconds: number, usedPercent: number, scope = ""): LimitWindow => ({
    scope,
    usedPercent,
    windowSeconds,
    resetsAt: SESSION_RESET,
    limitReached: usedPercent >= 100,
  });
  const windows = [window(18_000, 100), window(604_800, 40), window(18_000, 100, "Spark")];
  const credits = codexResetCredits({ available: 2, applicable: 2 }, list, NOW, windows)!;
  assert.deepEqual(
    credits.options!.map((item) => [item.id, item.family, item.label, item.blocker, item.helpsNow, item.recommended, item.movesWeeklyResetDay]),
    [
      ["soon", "full", "Launch", null, true, true, true],
      ["late", "full", "Bonus", null, true, false, true],
    ],
  );
  assert.deepEqual(
    credits.options![0]?.refills.map((limit) => [limit.key, limit.family, limit.usedPercent, limit.limitReached]),
    [
      ["five_hour", "five_hour", 100, true],
      ["seven_day", "weekly", 40, false],
    ],
  );
  assert.deepEqual(credits.limits!.map((limit) => [limit.family, limit.scope]), [["five_hour", ""], ["weekly", ""], ["scoped", "Spark"]]);
  assert.throws(() => pickResetOption(credits.options!, "", "manual"), /^Error: RESET_CHOICE_REQUIRED$/);
  assert.equal(pickResetOption(credits.options!, "late", "manual").id, "late");
  assert.equal(pickResetOption(credits.options!, "", "auto").id, "soon");
  assert.throws(() => pickResetOption(credits.options!, "spent", "manual"), /^Error: RESET_NOT_AVAILABLE$/);
  const calm = [window(18_000, 96), window(604_800, 40)];
  const idle = codexResetCredits({ available: 2, applicable: 2 }, list, NOW, calm)!;
  assert.deepEqual(idle.options!.map((item) => [item.blocker, item.helpsNow, item.recommended]), [[null, false, false], [null, false, false]]);
  assert.throws(() => pickResetOption(idle.options!, "", "auto"), /^Error: RESET_NOT_AVAILABLE$/);
  const lens = codexResetCredits({ available: 2, applicable: 2 }, list, NOW, calm, { reachedPercent: 95 })!;
  assert.equal(pickResetOption(lens.options!, "", "auto").id, "soon");
  const unusable = codexResetCredits({ available: 2, applicable: 0 }, list, NOW, windows)!;
  assert.deepEqual(unusable.options!.map((item) => item.blocker), ["not_usable", "not_usable"]);
  assert.throws(() => pickResetOption(unusable.options!, "soon", "manual"), /^Error: RESET_NOT_USABLE$/);
  const waiting = codexResetCredits({ available: 2, applicable: 0 }, list, NOW, calm)!;
  assert.deepEqual(waiting.options!.map((item) => item.blocker), ["needs_limit", "needs_limit"]);
});

test("the console view rebuilds options from the newest limits, hides the raw grant block, and blocks while a claim is unresolved", () => {
  const block = parseClaudeResets({
    ...usage(60, 20, 10),
    cedar_ember: { eligible: true, at_limit: false, grants: [fableGrant({ usable_now: true }), weeklyGrant()], next_grant_id: "weekly_1" },
  })!;
  const readAt = new Date(NOW - 30 * 60_000).toISOString();
  const stored: StoredResetView = { ...claudeResetCredits(block, NOW - 30 * 60_000), checkedAt: readAt, claude: block };
  assert.deepEqual(summary(stored.options!), { fable_1: ["needs_limit", false, false], weekly_1: ["needs_limit", false, false] });
  const limits = (windows: LimitWindow[], fetchedAt: string): SubscriptionLimits => ({
    plan: "max",
    windows,
    credits: null,
    resetCredits: null,
    extraUsage: null,
    fetchedAt,
  });
  const older = resetCreditsView("claude", limits(claudeWindows(usage(100, 0, 0)), new Date(NOW - 40 * 60_000).toISOString()), stored, null, NOW)!;
  assert.deepEqual(summary(older.options!), { fable_1: ["needs_limit", false, false], weekly_1: ["needs_limit", false, false] });
  const newer = resetCreditsView("claude", limits(claudeWindows(usage(100, 0, 0)), new Date(NOW - 60_000).toISOString()), stored, null, NOW)!;
  assert.deepEqual(summary(newer.options!), { fable_1: ["nothing_to_give_back", false, false], weekly_1: [null, true, true] });
  assert.equal(newer.applicable, 1);
  assert.equal(newer.canRedeem, true);
  assert.deepEqual(
    newer.grants?.map((item) => [item.id, item.usable]),
    [
      ["fable_1", false],
      ["weekly_1", true],
    ],
  );
  assert.deepEqual(newer.limits?.map((limit) => [limit.key, limit.limitReached]), [["seven_day", true], ["seven_day_overage_included", false]]);
  assert.equal("claude" in newer, false);
  assert.doesNotMatch(JSON.stringify(newer), /iguana|necktie|weekly_scoped/);
  const state: ResetState = {
    pending: { kind: "claude", requestId: "r1", grantId: "weekly_1", startedAt: NOW - 60_000, attempts: 1, trigger: "manual", actor: "u" },
    lastAutoAt: 0,
  };
  const held = resetCreditsView("claude", limits(claudeWindows(usage(100, 0, 0)), new Date(NOW - 60_000).toISOString()), stored, state, NOW)!;
  assert.deepEqual(summary(held.options!), { fable_1: ["pending", false, false], weekly_1: ["pending", true, false] });
  assert.equal(held.canRedeem, true);
  assert.deepEqual(pendingOptions(stored.options!).map((item) => item.blocker), ["pending", "pending"]);
  const codex = resetCreditsView(
    "codex",
    {
      ...limits([{ scope: "", usedPercent: 100, windowSeconds: 18_000, resetsAt: SESSION_RESET, limitReached: true }], readAt),
      resetCredits: { available: 2, applicable: 2 },
    },
    { available: 2, applicable: 2, credits: [{ id: "a", title: "A", expiresAt: "2026-11-20T00:00:00Z" }, { id: "gone", title: "", expiresAt: "2026-11-01T00:00:00Z" }] },
    null,
    NOW,
  )!;
  assert.deepEqual(codex.options?.map((item) => [item.id, item.blocker, item.recommended]), [["a", null, true]]);
  assert.deepEqual(codex.credits?.map((item) => item.id), ["a"]);
});
