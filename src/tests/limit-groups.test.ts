import assert from "node:assert/strict";
import test from "node:test";
import { antigravityLimits } from "@/lib/gateway/upstreams/antigravity";
import { antigravityFamily } from "@/lib/gateway/upstreams/antigravity-models";
import { limitGroups, summaryGroups } from "@/lib/gateway/upstreams/limit-groups";
import type { LimitGroup, LimitWindow, SubscriptionLimits } from "@/types/providers";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const iso = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

function window(over: Partial<LimitWindow>): LimitWindow {
  return { scope: "", usedPercent: 0, windowSeconds: 18_000, resetsAt: null, limitReached: false, ...over };
}

function limits(windows: LimitWindow[]): SubscriptionLimits {
  return { plan: "pro", windows, credits: null, resetCredits: null, extraUsage: null, fetchedAt: iso(0) };
}

function model(scope: string, usedPercent: number, hours: number | null, label?: string): LimitWindow {
  return window({
    scope,
    ...(label ? { label } : {}),
    usedPercent,
    windowSeconds: 0,
    resetsAt: hours === null ? null : iso(hours),
    limitReached: usedPercent >= 100,
  });
}

function shape(group: LimitGroup) {
  return {
    id: group.id,
    scoped: group.scoped,
    family: group.family,
    label: group.label,
    windowSeconds: group.windowSeconds,
    usedPercent: group.usedPercent,
    resetsAt: group.resetsAt,
    limitReached: group.limitReached,
    exhausted: group.exhausted,
    uniform: group.uniform,
    members: group.members.map((member) => member.scope),
  };
}

test("plan and scoped windows of the other kinds stay one group per window", () => {
  const codex = limits([
    window({ usedPercent: 40, windowSeconds: 604_800, resetsAt: iso(50) }),
    window({ usedPercent: 12, resetsAt: iso(2) }),
    window({ scope: "GPT-5.3-Codex-Spark", usedPercent: 5, resetsAt: iso(3) }),
    window({ scope: "GPT-5.3-Codex-Spark", usedPercent: 30, windowSeconds: 604_800, resetsAt: iso(90) }),
  ]);
  assert.deepEqual(limitGroups("codex", codex, NOW).map(shape), [
    {
      id: "plan:18000:0",
      scoped: false,
      family: null,
      label: "",
      windowSeconds: 18_000,
      usedPercent: 12,
      resetsAt: iso(2),
      limitReached: false,
      exhausted: false,
      uniform: true,
      members: [""],
    },
    {
      id: "plan:604800:1",
      scoped: false,
      family: null,
      label: "",
      windowSeconds: 604_800,
      usedPercent: 40,
      resetsAt: iso(50),
      limitReached: false,
      exhausted: false,
      uniform: true,
      members: [""],
    },
    {
      id: "scope:GPT-5.3-Codex-Spark:18000:0",
      scoped: true,
      family: null,
      label: "GPT-5.3-Codex-Spark",
      windowSeconds: 18_000,
      usedPercent: 5,
      resetsAt: iso(3),
      limitReached: false,
      exhausted: false,
      uniform: true,
      members: ["GPT-5.3-Codex-Spark"],
    },
    {
      id: "scope:GPT-5.3-Codex-Spark:604800:1",
      scoped: true,
      family: null,
      label: "GPT-5.3-Codex-Spark",
      windowSeconds: 604_800,
      usedPercent: 30,
      resetsAt: iso(90),
      limitReached: false,
      exhausted: false,
      uniform: true,
      members: ["GPT-5.3-Codex-Spark"],
    },
  ]);

  const claude = limits([
    window({ usedPercent: 20, resetsAt: iso(3) }),
    window({ usedPercent: 60, windowSeconds: 604_800, resetsAt: iso(80) }),
    window({ scope: "Sonnet", usedPercent: 70, windowSeconds: 604_800, resetsAt: iso(80) }),
    window({ scope: "Opus", usedPercent: 100, windowSeconds: 604_800, resetsAt: iso(80), limitReached: true }),
  ]);
  assert.deepEqual(
    limitGroups("claude", claude, NOW).map((group) => [group.scoped, group.label, group.usedPercent, group.limitReached]),
    [
      [false, "", 20, false],
      [false, "", 60, false],
      [true, "Sonnet", 70, false],
      [true, "Opus", 100, true],
    ],
  );

  const kimi = limits([
    window({ scope: "Coding", usedPercent: 10, windowSeconds: 18_000, resetsAt: iso(1) }),
    window({ usedPercent: 50, windowSeconds: 604_800, resetsAt: iso(100) }),
  ]);
  assert.deepEqual(
    limitGroups("kimi", kimi, NOW).map((group) => [group.scoped, group.label, group.windowSeconds, group.usedPercent]),
    [
      [false, "", 604_800, 50],
      [true, "Coding", 18_000, 10],
    ],
  );

  const devin = limits([
    window({ usedPercent: 100, windowSeconds: 86_400, resetsAt: iso(5), limitReached: true }),
    window({ usedPercent: 40, windowSeconds: 604_800, resetsAt: iso(60) }),
  ]);
  assert.deepEqual(
    limitGroups("devin", devin, NOW).map((group) => [group.scoped, group.windowSeconds, group.usedPercent, group.exhausted]),
    [
      [false, 86_400, 100, true],
      [false, 604_800, 40, false],
    ],
  );
  assert.deepEqual(limitGroups("codex", null, NOW), []);
});

test("windows that already reset count as unused", () => {
  const [group] = limitGroups(
    "devin",
    limits([window({ usedPercent: 100, windowSeconds: 86_400, resetsAt: iso(-1), limitReached: true })]),
    NOW,
  );
  assert.equal(group!.usedPercent, 0);
  assert.equal(group!.resetsAt, null);
  assert.equal(group!.limitReached, false);
  assert.equal(group!.exhausted, false);
});

test("antigravity models map to families", () => {
  assert.deepEqual(
    [
      "gemini-3-pro-high",
      "gemini-3.1-pro-low",
      "gemini-3-flash",
      "gemini-3.8-flash-high",
      "gemini-2.5-flash-lite",
      "gemini-3-pro-image",
      "gemini-3.1-flash-image",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
      "rev19-uic3-1p",
      "gemini-embedding",
    ].map(antigravityFamily),
    [
      "gemini_pro",
      "gemini_pro",
      "gemini_flash",
      "gemini_flash",
      "gemini_flash",
      "gemini_image",
      "gemini_image",
      "claude",
      "claude",
      "gpt_oss",
      "other",
      "other",
    ],
  );
});

test("antigravity windows group by family and hide internal and hidden models", () => {
  const snapshot = limits([
    model("claude-opus-4-6-thinking", 40, 4, "Claude Opus 4.6 (Thinking)"),
    model("claude-sonnet-4-6", 40, 4, "Claude Sonnet 4.6"),
    model("gemini-2.5-pro", 100, 2),
    model("gemini-3-flash", 20, 3, "Gemini 3 Flash"),
    model("gemini-3-pro-high", 0, null, "Gemini 3 Pro (High)"),
    model("gemini-3-pro-image", 100, 6, "Gemini 3 Pro Image"),
    model("gemini-3-pro-low", 0, null, "Gemini 3 Pro (Low)"),
    model("gemini-3.8-flash-high", 60, 5, "Gemini 3.8 Flash (High)"),
    model("gpt-oss-120b-medium", 10, 1),
    model("rev19-uic3-1p", 30, 2, "Rev 19"),
    model("rev20", 30, 2, "Rev 20"),
    model("tab_flash_lite_preview", 0, null),
    model("chat_20706", 100, 1),
    model("x-preview", 70, 8, "X Preview"),
  ]);
  const groups = limitGroups("antigravity", snapshot, NOW);
  assert.deepEqual(groups.map(shape), [
    {
      id: "family:gemini_pro",
      scoped: true,
      family: "gemini_pro",
      label: "",
      windowSeconds: 0,
      usedPercent: 0,
      resetsAt: null,
      limitReached: false,
      exhausted: false,
      uniform: true,
      members: ["gemini-3-pro-high", "gemini-3-pro-low"],
    },
    {
      id: "family:gemini_flash",
      scoped: true,
      family: "gemini_flash",
      label: "",
      windowSeconds: 0,
      usedPercent: 60,
      resetsAt: iso(5),
      limitReached: false,
      exhausted: false,
      uniform: false,
      members: ["gemini-3-flash", "gemini-3.8-flash-high"],
    },
    {
      id: "family:gemini_image",
      scoped: true,
      family: "gemini_image",
      label: "",
      windowSeconds: 0,
      usedPercent: 100,
      resetsAt: iso(6),
      limitReached: true,
      exhausted: true,
      uniform: true,
      members: ["gemini-3-pro-image"],
    },
    {
      id: "family:claude",
      scoped: true,
      family: "claude",
      label: "",
      windowSeconds: 0,
      usedPercent: 40,
      resetsAt: iso(4),
      limitReached: false,
      exhausted: false,
      uniform: true,
      members: ["claude-opus-4-6-thinking", "claude-sonnet-4-6"],
    },
    {
      id: "family:gpt_oss",
      scoped: true,
      family: "gpt_oss",
      label: "",
      windowSeconds: 0,
      usedPercent: 10,
      resetsAt: iso(1),
      limitReached: false,
      exhausted: false,
      uniform: true,
      members: ["gpt-oss-120b-medium"],
    },
    {
      id: "other:rev19-uic3-1p",
      scoped: true,
      family: "other",
      label: "",
      windowSeconds: 0,
      usedPercent: 30,
      resetsAt: iso(2),
      limitReached: false,
      exhausted: false,
      uniform: true,
      members: ["rev19-uic3-1p", "rev20"],
    },
    {
      id: "other:x-preview",
      scoped: true,
      family: null,
      label: "X Preview",
      windowSeconds: 0,
      usedPercent: 70,
      resetsAt: iso(8),
      limitReached: false,
      exhausted: false,
      uniform: true,
      members: ["x-preview"],
    },
  ]);
  assert.deepEqual(
    groups[0]!.members.map((member) => member.label),
    ["Gemini 3 Pro (High)", "Gemini 3 Pro (Low)"],
  );
  assert.deepEqual(
    groups[4]!.members.map((member) => member.label),
    ["gpt-oss-120b-medium"],
  );
});

test("old antigravity snapshots without labels still group and hide hidden models", () => {
  const old = limits([
    model("chat_23310", 100, 1),
    model("claude-sonnet-4-6", 100, 3),
    model("gemini-2.5-flash-thinking", 100, 2),
    model("gemini-3-flash", 50, 2),
  ]);
  const groups = limitGroups("antigravity", old, NOW);
  assert.deepEqual(
    groups.map((group) => [group.id, group.members.map((member) => [member.scope, member.label])]),
    [
      ["family:gemini_flash", [["gemini-3-flash", "gemini-3-flash"]]],
      ["family:claude", [["claude-sonnet-4-6", "claude-sonnet-4-6"]]],
    ],
  );
});

test("fresh antigravity limits group without the internal models", () => {
  const reset = iso(2);
  const groups = limitGroups(
    "antigravity",
    antigravityLimits(
      {
        models: {
          chat_20706: { quotaInfo: { remainingFraction: 1 } },
          tab_jump_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
          "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0, resetTime: reset } },
          "gemini-3-pro-high": { displayName: "Gemini 3 Pro (High)", quotaInfo: { remainingFraction: 0.5, resetTime: reset } },
        },
      },
      "pro",
      NOW,
    ),
    NOW,
  );
  assert.deepEqual(
    groups.map((group) => [group.id, group.usedPercent, group.members.map((member) => member.label)]),
    [["family:gemini_pro", 50, ["Gemini 3 Pro (High)"]]],
  );
});

test("the summary shows plan windows first, then the tightest scoped groups", () => {
  const claude = limitGroups(
    "claude",
    limits([
      window({ usedPercent: 20, resetsAt: iso(3) }),
      window({ usedPercent: 60, windowSeconds: 604_800, resetsAt: iso(80) }),
      window({ scope: "Sonnet", usedPercent: 70, windowSeconds: 604_800, resetsAt: iso(80) }),
      window({ scope: "Opus", usedPercent: 90, windowSeconds: 604_800, resetsAt: iso(80) }),
    ]),
    NOW,
  );
  const summary = summaryGroups(claude);
  assert.deepEqual(
    summary.groups.map((group) => [group.scoped, group.label, group.usedPercent]),
    [
      [false, "", 20],
      [false, "", 60],
      [true, "Opus", 90],
    ],
  );
  assert.equal(summary.more, 1);
  assert.deepEqual(summaryGroups(claude, 1).groups.map((group) => group.usedPercent), [20]);
  assert.equal(summaryGroups(claude, 1).more, 3);

  const antigravity = limitGroups(
    "antigravity",
    limits([
      model("claude-sonnet-4-6", 40, 4),
      model("gemini-3-flash", 100, 3),
      model("gemini-3-pro-high", 10, 2),
      model("gemini-3-pro-image", 80, 6),
      model("gpt-oss-120b-medium", 80, 1),
    ]),
    NOW,
  );
  const top = summaryGroups(antigravity);
  assert.deepEqual(
    top.groups.map((group) => group.id),
    ["family:gemini_flash", "family:gemini_image", "family:gpt_oss"],
  );
  assert.equal(top.more, 2);
  assert.deepEqual(summaryGroups([]), { groups: [], more: 0 });
});
