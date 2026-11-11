import assert from "node:assert/strict";
import test from "node:test";
import {
  groupTone,
  limitTone,
  resetLimitTone,
  TONE_COLOR,
  TONE_FILL,
  TONE_STATE,
  type LimitTone,
} from "@/app/(app)/providers/_components/limit-tone";
import {
  defaultResetOption,
  isSpendable,
  leftAfterUse,
  limitNaming,
  optionNaming,
  orderResetOptions,
  recommendedReset,
  resetEffects,
  resetFlow,
  resetRefusal,
  upstreamLabel,
} from "@/app/(app)/providers/_components/reset-view";
import type { ResetCredits, ResetLimit, ResetOption } from "@/types/resets";

function limit(over: Partial<ResetLimit> = {}): ResetLimit {
  return { key: "weekly", family: "weekly", scope: "", usedPercent: 0, limitReached: false, resetsAt: null, ...over };
}

function option(over: Partial<ResetOption> = {}): ResetOption {
  return {
    id: "reset",
    family: "weekly",
    scope: "",
    label: "",
    refills: [],
    givesBack: null,
    movesWeeklyResetDay: false,
    left: 1,
    total: 1,
    expiresAt: null,
    blocker: null,
    helpsNow: false,
    recommended: false,
    ...over,
  };
}

const fiveHour = limit({ key: "five_hour", family: "five_hour", usedPercent: 40 });
const weeklyFull = limit({ usedPercent: 100, limitReached: true, resetsAt: "2026-11-14T09:00:00.000Z" });
const fableIdle = limit({ key: "fable", family: "scoped", scope: "Fable", usedPercent: 0 });

const fableReset = option({
  id: "grant_fable",
  family: "scoped",
  scope: "Fable",
  label: "iguana_necktie",
  refills: [fableIdle],
  givesBack: { scope: "Fable", percentOfWeekly: 0 },
  blocker: "nothing_to_give_back",
});
const fullReset = option({
  id: "grant_full",
  family: "full",
  refills: [weeklyFull, fiveHour],
  left: 2,
  total: 3,
  helpsNow: true,
  recommended: true,
});

const account: ResetCredits = {
  available: 3,
  applicable: 2,
  canRedeem: true,
  options: [fableReset, fullReset],
  limits: [fiveHour, weeklyFull, fableIdle],
};

test("with the weekly limit full and Fable unused, the full reset leads and the Fable reset is blocked", () => {
  const flow = resetFlow(account);
  assert.equal(flow.mode, "choose");
  if (flow.mode !== "choose") return;
  assert.deepEqual(
    flow.options.map((item) => item.id),
    ["grant_full", "grant_fable"],
  );
  assert.equal(flow.initial, "grant_full");
  assert.equal(recommendedReset(account)?.id, "grant_full");
  assert.equal(isSpendable(fableReset), false);
  assert.equal(fableReset.blocker, "nothing_to_give_back");
  assert.equal(defaultResetOption([fableReset])?.id, undefined);
});

test("the full reset shows every refilled limit going to zero and nothing staying full", () => {
  const effects = resetEffects(fullReset, account.limits ?? []);
  assert.deepEqual(
    effects.refills.map((effect) => [effect.limit.key, effect.before, effect.after]),
    [
      ["five_hour", 40, 0],
      ["weekly", 100, 0],
    ],
  );
  assert.equal(effects.givesBack, null);
  assert.deepEqual(effects.staysFull, []);
  assert.equal(leftAfterUse(fullReset), 1);
  assert.equal(leftAfterUse(option({ left: 0 })), 0);
});

test("a blocked Fable reset would give nothing back and leaves the weekly limit full", () => {
  const effects = resetEffects(fableReset, account.limits ?? []);
  assert.deepEqual(
    effects.refills.map((effect) => [effect.limit.key, effect.before, effect.after]),
    [["fable", 0, 0]],
  );
  assert.equal(effects.givesBack?.scope, "Fable");
  assert.equal(effects.givesBack?.percent, 0);
  assert.deepEqual([effects.givesBack?.weekly?.before, effects.givesBack?.weekly?.after], [100, 100]);
  assert.deepEqual(
    effects.staysFull.map((item) => item.key),
    ["weekly"],
  );
});

test("a reset that gives usage back eases the weekly limit by that share", () => {
  const fable = limit({ key: "fable", family: "scoped", scope: "Fable", usedPercent: 100, limitReached: true });
  const given = option({ family: "scoped", scope: "Fable", refills: [fable], givesBack: { scope: " Fable ", percentOfWeekly: 12 } });
  const effects = resetEffects(given, [fiveHour, weeklyFull, fable]);
  assert.deepEqual(
    effects.refills.map((effect) => [effect.limit.key, effect.before, effect.after]),
    [["fable", 100, 0]],
  );
  assert.deepEqual(effects.givesBack, {
    scope: "Fable",
    percent: 12,
    weekly: { limit: weeklyFull, before: 100, after: 88 },
  });
  assert.deepEqual(effects.staysFull, []);

  const unknown = resetEffects({ ...given, givesBack: { scope: "Fable", percentOfWeekly: null } }, [weeklyFull, fable]);
  assert.equal(unknown.givesBack?.percent, null);
  assert.equal(unknown.givesBack?.weekly?.after, null);
  assert.deepEqual(unknown.staysFull, []);

  const noWeekly = resetEffects(given, [fable]);
  assert.equal(noWeekly.givesBack?.weekly, null);
});

test("limits a reset does not touch stay full, and unknown usage of a reached limit counts as full", () => {
  const fable = limit({ key: "fable", family: "scoped", scope: "Fable", usedPercent: null, limitReached: true });
  const short = option({ family: "five_hour", refills: [limit({ key: "five_hour", family: "five_hour", usedPercent: null, limitReached: true })] });
  const effects = resetEffects(short, [short.refills[0]!, weeklyFull, fable]);
  assert.deepEqual(
    effects.refills.map((effect) => [effect.before, effect.after]),
    [[100, 0]],
  );
  assert.deepEqual(
    effects.staysFull.map((item) => item.key),
    ["weekly", "fable"],
  );
  const idle = resetEffects(option({ refills: [limit({ usedPercent: null })] }), []);
  assert.deepEqual(
    idle.refills.map((effect) => [effect.before, effect.after]),
    [[null, 0]],
  );
});

test("options sort by recommended, helping now, spendable, then blocked, with family and expiry as tie breakers", () => {
  const ordered = orderResetOptions([
    option({ id: "blocked", blocker: "cooldown", recommended: true }),
    option({ id: "late", family: "five_hour", expiresAt: "2026-12-01T00:00:00.000Z" }),
    option({ id: "soon", family: "five_hour", expiresAt: "2026-11-20T00:00:00.000Z" }),
    option({ id: "open", family: "five_hour" }),
    option({ id: "scoped", family: "scoped", scope: "Fable", helpsNow: true }),
    option({ id: "weekly", family: "weekly", helpsNow: true }),
    option({ id: "pick", family: "other", recommended: true }),
  ]);
  assert.deepEqual(
    ordered.map((item) => item.id),
    ["pick", "weekly", "scoped", "soon", "late", "open", "blocked"],
  );
});

test("the preselection is the recommended option, a lone spendable one, or nothing", () => {
  const a = option({ id: "a" });
  const b = option({ id: "b" });
  assert.equal(defaultResetOption([a, b]), null);
  assert.equal(defaultResetOption([a, { ...b, recommended: true }])?.id, "b");
  assert.equal(defaultResetOption([a, { ...b, blocker: "paused" }])?.id, "a");
  assert.equal(defaultResetOption([{ ...a, blocker: "paused", recommended: true }, { ...b, blocker: "exhausted" }]), null);
});

test("the flow skips the choice for one option, retries a pending claim, and falls back without options", () => {
  assert.deepEqual(resetFlow({ available: 1, applicable: 1, options: [fullReset] }), { mode: "review", option: fullReset });
  assert.deepEqual(resetFlow({ available: 1, applicable: 1 }), { mode: "plain" });
  assert.deepEqual(resetFlow({ available: 1, applicable: 1, options: [] }), { mode: "plain" });
  const pending = { startedAt: "", retryUntil: "", retryable: true };
  assert.deepEqual(resetFlow({ ...account, pending }), { mode: "retry" });
  assert.deepEqual(resetFlow({ ...account, pending: { ...pending, retryable: false } }), { mode: "plain" });
  assert.equal(recommendedReset({ ...account, pending }), null);
});

test("resets and limits are named by family and scope, never by an upstream codename", () => {
  assert.deepEqual(optionNaming(fullReset), { family: "full", scope: "" });
  assert.deepEqual(optionNaming(fableReset), { family: "scoped", scope: "Fable" });
  assert.deepEqual(optionNaming(option({ family: "scoped", scope: "  " })), { family: "other", scope: "" });
  assert.deepEqual(optionNaming(option({ family: "weekly", scope: "seven_day" })), { family: "weekly", scope: "" });
  assert.deepEqual(limitNaming(fableIdle), { family: "scoped", scope: "Fable" });
  assert.deepEqual(limitNaming(limit({ family: "other", scope: "iguana_necktie" })), { family: "other", scope: "" });
  assert.deepEqual(limitNaming(limit({ family: "scoped", scope: "" })), { family: "other", scope: "" });
  assert.equal(upstreamLabel(fableReset), "");
  assert.equal(upstreamLabel(option({ label: "seven-day-opus" })), "");
  assert.equal(upstreamLabel(option({ label: " Launch reset " })), "Launch reset");
  assert.equal(upstreamLabel(option({ label: "" })), "");
});

test("refused redeems map to a choice prompt or the matching blocker", () => {
  assert.deepEqual(resetRefusal("RESET_CHOICE_REQUIRED"), { kind: "choice" });
  assert.deepEqual(resetRefusal("RESET_NOTHING_TO_GIVE_BACK"), { kind: "blocker", blocker: "nothing_to_give_back" });
  assert.deepEqual(resetRefusal("RESET_BLOCKED_OTHER_LIMIT"), { kind: "blocker", blocker: "other_limit" });
  assert.deepEqual(resetRefusal("RESET_COOLDOWN"), { kind: "blocker", blocker: "cooldown" });
  assert.equal(resetRefusal("RESET_BUSY"), null);
  assert.equal(resetRefusal("RESET_NOT_AVAILABLE"), null);
  assert.equal(resetRefusal("SIGN_IN_EXPIRED"), null);
});

test("full limits grade into distinct red tones and near-full stays apart from full", () => {
  const base = { limitReached: false, short: false, scoped: false };
  assert.equal(limitTone({ ...base, usedPercent: 79 }), "calm");
  assert.equal(limitTone({ ...base, usedPercent: 80 }), "rising");
  assert.equal(limitTone({ ...base, usedPercent: 90 }), "near");
  assert.equal(limitTone({ ...base, usedPercent: 100 }), "full");
  assert.equal(limitTone({ ...base, usedPercent: 62, limitReached: true }), "full");
  assert.equal(limitTone({ ...base, usedPercent: null, limitReached: true, scoped: true }), "full_scoped");
  assert.equal(limitTone({ ...base, usedPercent: 100, short: true, scoped: true }), "full_short");
  assert.equal(limitTone({ ...base, usedPercent: null }), "calm");

  assert.equal(resetLimitTone(weeklyFull), "full");
  assert.equal(resetLimitTone({ ...weeklyFull, family: "scoped" }), "full_scoped");
  assert.equal(resetLimitTone({ ...weeklyFull, family: "five_hour" }), "full_short");
  assert.equal(groupTone({ usedPercent: 100, limitReached: true, windowSeconds: 18_000, scoped: false }), "full_short");
  assert.equal(groupTone({ usedPercent: 100, limitReached: true, windowSeconds: 604_800, scoped: true }), "full_scoped");
  assert.equal(groupTone({ usedPercent: 100, limitReached: true, windowSeconds: 604_800, scoped: false }), "full");
  assert.equal(groupTone({ usedPercent: 93, limitReached: false, windowSeconds: 0, scoped: false }), "near");

  const red: LimitTone[] = ["near", "full_short", "full_scoped", "full"];
  assert.equal(new Set(red.map((tone) => TONE_FILL[tone])).size, red.length);
  for (const tone of red) {
    assert.equal(TONE_COLOR[tone], "danger");
    assert.match(TONE_FILL[tone] ?? "", /^bg-danger(?:\/\d+)?$/);
  }
  assert.deepEqual(
    red.map((tone) => TONE_STATE[tone]),
    ["near", "full", "full", "full"],
  );
  assert.equal(TONE_COLOR.rising, "warning");
  assert.equal(TONE_COLOR.calm, "accent");
});
