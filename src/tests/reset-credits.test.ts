import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  claimClaudeReset,
  claudeOutcome,
  claudeResetCredits,
  codexOutcome,
  codexResetCredits,
  consumeCodexCredit,
  parseClaudeResets,
  parseCodexCredits,
  redeemSucceeded,
  retryAfterMs,
  sanitizeLabel,
  selectGrant,
  soonestCredit,
} from "@/lib/gateway/upstreams/reset-credits";
import { autoResetPoliciesOf, autoResetPolicy, isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import type { JsonMap } from "@/types/gateway";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const ORG = "4f6c1f2e-8a3b-4c5d-9e7f-0123456789ab";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function grant(change: JsonMap = {}): JsonMap {
  return {
    id: "launch_1",
    label: "Launch reset",
    resets_total: 1,
    resets_left: 1,
    starts_at: "2026-10-01T00:00:00Z",
    ends_at: "2026-10-22T00:00:00Z",
    clears: ["five_hour", "seven_day", "seven_day_overage_included"],
    usable_now: true,
    ...change,
  };
}

function block(change: JsonMap = {}, grants: unknown[] = [grant()]): JsonMap {
  return { cedar_ember: { eligible: true, at_limit: true, grants, next_grant_id: "launch_1", ...change } };
}

test("a Claude cedar_ember block parses grants with their documented defaults", () => {
  const parsed = parseClaudeResets(
    block({ weekly_resets_at: "2026-10-24T08:00:00+02:00", cooldown_until: null }, [
      grant({ percent_used: { five_hour: 100 } }),
      { id: "spare", label: null, resets_total: 2, resets_left: 0 },
    ]),
  );
  assert.ok(parsed);
  assert.equal(parsed.eligible, true);
  assert.equal(parsed.ineligibleReason, null);
  assert.equal(parsed.atLimit, true);
  assert.equal(parsed.nextGrantId, "launch_1");
  assert.equal(parsed.weeklyResetsAt, "2026-10-24T06:00:00.000Z");
  assert.equal(parsed.cooldownUntil, null);
  assert.deepEqual(parsed.grants[0], {
    id: "launch_1",
    label: "Launch reset",
    resetsTotal: 1,
    resetsLeft: 1,
    startsAt: "2026-10-01T00:00:00.000Z",
    endsAt: "2026-10-22T00:00:00.000Z",
    clears: ["five_hour", "seven_day", "seven_day_overage_included"],
    paused: false,
    usableNow: true,
    useRequiresLimit: true,
    percentUsed: { five_hour: 100 },
  });
  assert.deepEqual(
    { usableNow: parsed.grants[1]!.usableNow, useRequiresLimit: parsed.grants[1]!.useRequiresLimit, label: parsed.grants[1]!.label },
    { usableNow: false, useRequiresLimit: true, label: "" },
  );
});

test("one malformed grant, a duplicate id, or a bad timestamp rejects the whole Claude block", () => {
  assert.equal(parseClaudeResets(block({}, [grant(), grant({ id: "Bad Id" })])), null);
  assert.equal(parseClaudeResets(block({}, [grant(), grant()])), null);
  assert.equal(parseClaudeResets(block({}, [grant({ ends_at: "next tuesday" })])), null);
  assert.equal(parseClaudeResets(block({}, [grant({ ends_at: 1_760_000_000 })])), null);
  assert.equal(parseClaudeResets(block({}, [grant({ resets_left: 2, resets_total: 1 })])), null);
  assert.equal(parseClaudeResets(block({}, [grant({ resets_left: 1.5 })])), null);
  assert.equal(parseClaudeResets(block({}, [grant({ clears: ["five hour"] })])), null);
  assert.equal(parseClaudeResets(block({}, [grant({ paused: "no" })])), null);
  assert.equal(parseClaudeResets(block({}, [grant({ percent_used: { five_hour: 140 } })])), null);
  assert.equal(parseClaudeResets(block({ cooldown_until: "soon" })), null);
  assert.equal(parseClaudeResets(block({ next_grant_id: "NOPE!" })), null);
  assert.equal(parseClaudeResets(block({ grants: "none" })), null);
  assert.equal(parseClaudeResets({ cedar_ember: { grants: [] } }), null);
  assert.equal(parseClaudeResets({ five_hour: { utilization: 3 } }), null);
});

test("Claude labels lose control characters and stop at 120 characters", () => {
  assert.equal(sanitizeLabel("Launch\u0000 reset‮\n"), "Launch reset");
  assert.equal(sanitizeLabel("x".repeat(300)).length, 120);
  const parsed = parseClaudeResets(block({}, [grant({ label: `\u0007${"y".repeat(200)}` })]));
  assert.equal(parsed?.grants[0]?.label, "y".repeat(120));
});

test("an unknown ineligible reason becomes unknown and keeps the block", () => {
  const parsed = parseClaudeResets({ cedar_ember: { eligible: false, ineligible_reason: "brand_new_reason" } });
  assert.equal(parsed?.ineligibleReason, "unknown");
  assert.equal(parseClaudeResets({ cedar_ember: { eligible: false, ineligible_reason: "tier" } })?.ineligibleReason, "tier");
  assert.equal(selectGrant(parsed, NOW), null);
});

test("grant selection prefers next_grant_id, then the lowest usable id", () => {
  const grants = [grant({ id: "b_grant" }), grant({ id: "a_grant" }), grant({ id: "c_grant" })];
  assert.equal(selectGrant(parseClaudeResets(block({ next_grant_id: "c_grant" }, grants)), NOW)?.id, "c_grant");
  assert.equal(selectGrant(parseClaudeResets(block({ next_grant_id: null }, grants)), NOW)?.id, "a_grant");
  assert.equal(selectGrant(parseClaudeResets(block({ next_grant_id: "gone" }, grants)), NOW)?.id, "a_grant");
});

test("grant selection skips cooldowns, unusable, paused, spent, and out-of-window grants", () => {
  const select = (change: JsonMap, grants: unknown[] = [grant()]) => selectGrant(parseClaudeResets(block(change, grants)), NOW);
  assert.equal(select({ cooldown_until: "2026-10-19T13:00:00Z" }), null);
  assert.equal(select({ cooldown_until: "2026-10-19T11:00:00Z" })?.id, "launch_1");
  assert.equal(select({ eligible: false }), null);
  assert.equal(select({ at_limit: false }), null);
  assert.equal(select({ at_limit: false }, [grant({ use_requires_limit: false })])?.id, "launch_1");
  assert.equal(select({}, [grant({ usable_now: undefined })]), null);
  assert.equal(select({}, [grant({ paused: true })]), null);
  assert.equal(select({}, [grant({ resets_left: 0 })]), null);
  assert.equal(select({}, [grant({ starts_at: "2026-10-20T00:00:00Z" })]), null);
  assert.equal(select({}, [grant({ ends_at: "2026-10-19T11:59:59Z" })]), null);
});

test("Claude reset credits summarize live grants for the console", () => {
  const parsed = parseClaudeResets(
    block({ at_limit: false }, [
      grant({ id: "a_grant", ends_at: "2026-10-25T00:00:00Z", resets_left: 2, resets_total: 3 }),
      grant({ id: "b_grant", use_requires_limit: false }),
      grant({ id: "old", ends_at: "2026-10-01T00:00:00Z" }),
    ]),
  )!;
  const credits = claudeResetCredits(parsed, NOW);
  assert.equal(credits.available, 3);
  assert.equal(credits.applicable, 1);
  assert.equal(credits.expiresAt, "2026-10-22T00:00:00.000Z");
  assert.deepEqual(
    credits.grants?.map((item) => [item.id, item.usable, item.resetsLeft]),
    [
      ["a_grant", false, 2],
      ["b_grant", true, 1],
    ],
  );
  assert.equal(credits.atLimit, false);
  assert.equal(credits.cooldownUntil, null);
  const cooling = claudeResetCredits(parseClaudeResets(block({ cooldown_until: "2026-10-19T12:30:00Z" }))!, NOW);
  assert.equal(cooling.applicable, 0);
  assert.equal(cooling.cooldownUntil, "2026-10-19T12:30:00.000Z");
});

test("the Codex credit list keeps available credits and picks the soonest expiry", () => {
  const list = parseCodexCredits({
    credits: [
      { id: "late", reset_type: "codex_rate_limits", status: "available", expires_at: "2026-11-30T00:00:00Z", title: "Bonus" },
      { id: "soon", reset_type: "codex_rate_limits", status: "available", expires_at: "2026-10-20T00:00:00Z", title: "Launch\u0000" },
      { id: "never", status: "available", expires_at: null },
      { id: "spent", status: "redeemed", expires_at: "2026-10-20T00:00:00Z" },
      { id: "expired", status: "available", expires_at: "2026-10-01T00:00:00Z" },
      { id: "other", reset_type: "something_else", status: "available" },
      { status: "available" },
    ],
    available_count: 4,
    total_earned_count: 6,
    immediate_reset_purchase_eligible: false,
    history_enabled: true,
  });
  assert.ok(list);
  assert.equal(list.availableCount, 4);
  assert.equal(list.totalEarnedCount, 6);
  assert.equal(soonestCredit(list, NOW)?.id, "soon");
  const credits = codexResetCredits({ available: 3, applicable: 1 }, list, NOW);
  assert.deepEqual(credits, {
    available: 3,
    applicable: 1,
    expiresAt: "2026-10-20T00:00:00.000Z",
    credits: [
      { id: "soon", title: "Launch", expiresAt: "2026-10-20T00:00:00.000Z" },
      { id: "late", title: "Bonus", expiresAt: "2026-11-30T00:00:00.000Z" },
      { id: "never", title: "", expiresAt: null },
    ],
  });
  const free = parseCodexCredits({
    credits: [],
    available_count: 0,
    total_earned_count: 0,
    immediate_reset_purchase_eligible: false,
    history_enabled: true,
  });
  assert.deepEqual(free, { credits: [], availableCount: 0, totalEarnedCount: 0, purchaseEligible: false });
  assert.equal(parseCodexCredits({ credits: "none" }), null);
  assert.equal(codexResetCredits(null, null, NOW), null);
  assert.deepEqual(codexResetCredits({ available: 2, applicable: 0 }, null, NOW), {
    available: 2,
    applicable: 0,
    expiresAt: null,
    credits: [],
  });
});

test("redeem answers map to stable results and unknown outcomes", () => {
  assert.deepEqual(codexOutcome(200, { code: "reset", windows_reset: 2 }), { result: "reset", windowsReset: 2 });
  assert.deepEqual(codexOutcome(200, { code: "nothing_to_reset" }), { result: "nothing_to_reset", windowsReset: 0 });
  assert.deepEqual(codexOutcome(409, { code: "already_redeemed" }), { result: "already_redeemed", windowsReset: 0 });
  assert.deepEqual(codexOutcome(200, { code: "no_credit", windows_reset: -1 }), { result: "no_credit", windowsReset: 0 });
  assert.equal(codexOutcome(429, { code: "reset" }).result, "rate_limited");
  assert.equal(codexOutcome(401, null).result, "auth_error");
  assert.equal(codexOutcome(502, { code: "reset" }).result, "unknown");
  assert.equal(codexOutcome(200, { code: "mystery" }).result, "unknown");
  assert.equal(codexOutcome(0, null).result, "unknown");
  for (const result of ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"]) {
    assert.equal(claudeOutcome(200, { result }).result, result);
  }
  assert.equal(claudeOutcome(400, { result: "not_limited" }).result, "not_limited");
  assert.equal(claudeOutcome(429, null).result, "rate_limited");
  assert.equal(claudeOutcome(403, null).result, "auth_error");
  assert.equal(claudeOutcome(500, { result: "reset" }).result, "unknown");
  assert.equal(claudeOutcome(200, null).result, "unknown");
  assert.equal(redeemSucceeded("reset"), true);
  assert.equal(redeemSucceeded("already_redeemed"), true);
  assert.equal(redeemSucceeded("already_used"), true);
  assert.equal(redeemSucceeded("not_limited"), false);
  assert.equal(redeemSucceeded("unknown"), false);
});

test("Retry-After accepts seconds and HTTP dates", () => {
  assert.equal(retryAfterMs("3000", NOW), 3_000_000);
  assert.equal(retryAfterMs(new Date(NOW + 60_000).toUTCString(), NOW), 60_000);
  assert.equal(retryAfterMs("soon", NOW), null);
  assert.equal(retryAfterMs(null, NOW), null);
});

test("the Codex consume call sends the redeem request id and an optional credit id", async () => {
  const sent: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Response.json({ code: "reset", windows_reset: 2, credit: { id: "c1" } });
  }) as typeof fetch;
  const auth = { key: "tok", headers: { "ChatGPT-Account-ID": "acct_1", originator: "llmhub" } };
  const outcome = await consumeCodexCredit(auth, { redeemRequestId: "req-1", creditId: "c1" });
  assert.deepEqual(outcome, { result: "reset", windowsReset: 2 });
  await consumeCodexCredit(auth, { redeemRequestId: "req-2" });
  assert.equal(sent[0]?.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
  assert.equal(sent[0]?.method, "POST");
  assert.deepEqual(JSON.parse(sent[0]!.body), { redeem_request_id: "req-1", credit_id: "c1" });
  assert.deepEqual(JSON.parse(sent[1]!.body), { redeem_request_id: "req-2" });
  assert.equal(sent[0]?.headers.Authorization, "Bearer tok");
  assert.equal(sent[0]?.headers["ChatGPT-Account-ID"], "acct_1");
  assert.equal(sent[0]?.headers["Content-Type"], "application/json");
});

test("the Claude claim posts the cedar_ember program to the organization and validates ids first", async () => {
  const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: String(init?.body ?? ""), headers: (init?.headers ?? {}) as Record<string, string> });
    return Response.json({ result: "reset" });
  }) as typeof fetch;
  const auth = { key: "tok", headers: { "User-Agent": "claude-cli/2.1.280 (external, cli)" } };
  const outcome = await claimClaudeReset(auth, { orgUuid: ORG, grantId: "launch_1", requestId: "req_1" });
  assert.deepEqual(outcome, { result: "reset", windowsReset: 0 });
  assert.equal(sent[0]?.url, `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`);
  assert.deepEqual(JSON.parse(sent[0]!.body), { program: "cedar_ember", grant_id: "launch_1", request_id: "req_1" });
  assert.match(sent[0]?.headers["anthropic-beta"] ?? "", /oauth-2025-04-20/);
  await assert.rejects(claimClaudeReset(auth, { orgUuid: "../evil", grantId: "launch_1", requestId: "req_1" }), /VALIDATION/);
  await assert.rejects(claimClaudeReset(auth, { orgUuid: ORG, grantId: "launch_1", requestId: "bad id!" }), /VALIDATION/);
  assert.equal(sent.length, 1);
});

test("auto reset policies default to off, 99 percent, and pool scope", () => {
  assert.deepEqual(autoResetPolicy({}), { enabled: false, percent: 99, scope: "pool" });
  assert.deepEqual(autoResetPolicy({ autoReset: true, autoResetPercent: 20, autoResetScope: "account" }), {
    enabled: true,
    percent: 50,
    scope: "account",
  });
  assert.deepEqual(autoResetPolicy({ autoReset: true, autoResetPercent: 120, autoResetScope: "everyone" }), {
    enabled: true,
    percent: 100,
    scope: "pool",
  });
  assert.deepEqual(
    autoResetPoliciesOf([
      { kind: "codex", autoReset: true, autoResetPercent: 95, autoResetScope: "account" },
      { kind: "grok_build", autoReset: true },
    ]),
    { codex: { enabled: true, percent: 95, scope: "account" } },
  );
  assert.equal(isResetKind("claude"), true);
  assert.equal(isResetKind("antigravity"), false);
});
