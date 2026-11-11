import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_CODE_IDENTITY, withClaudeBetas, withClaudeIdentity } from "@/lib/gateway/upstreams/claude";
import { signInHeaders } from "@/lib/gateway/upstreams/credentials";
import { joinPath, prepareBody, upstreamError, upstreamHeaders, upstreamRetryAt } from "@/lib/gateway/dispatch/upstream";
import { modelRecoveryAt, quotaExhausted } from "@/lib/gateway/routing/quota";
import { routePool } from "@/lib/gateway/routing/route-pool";
import {
  claudeHeaderWindows,
  claudeModelLimitReached,
  limitsUpdatedAt,
  newestLimits,
  observedChanged,
  observedFlipped,
  updatedFromTraffic,
  withModelLimitReached,
  withObservedWindows,
} from "@/lib/gateway/upstreams/observed-limits";
import type { LimitWindow, SubscriptionLimits } from "@/types/providers";
import type { ResolvedDeployment } from "@/types/routing";

const claudeDep: ResolvedDeployment = {
  id: "c1",
  kind: "claude",
  base_url: "https://evil.example",
  model: "claude-sonnet-4-5",
  weight: 1,
  cost_input_per_1k: 0,
  cost_output_per_1k: 0,
  provider_id: "p1",
};

test("Claude subscription deployments belong to the subscription pool", () => {
  assert.equal(routePool({ kind: "claude" }), "subscription");
  assert.equal(routePool({ kind: "anthropic", provider: { kind: "claude", internal: false } }), "subscription");
  assert.equal(routePool({ kind: "anthropic" }), "api");
});

test("Claude deployments use the pinned Messages endpoint", () => {
  assert.equal(joinPath(claudeDep, "/chat/completions"), "https://api.anthropic.com/v1/messages");
  assert.equal(joinPath(claudeDep, "/v1/messages"), "https://api.anthropic.com/v1/messages");
});

test("Claude requests send the OAuth bearer token and merge client betas", () => {
  const headers = upstreamHeaders(
    claudeDep,
    { key: "sk-ant-oat01-a", headers: signInHeaders("claude", { access: "a", refresh: "r", accountId: "", residency: "" }) },
    { "anthropic-beta": "context-1m-2025-08-07, oauth-2025-04-20", "x-api-key": "spoofed" },
  );
  assert.equal(headers.Authorization, "Bearer sk-ant-oat01-a");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-app"], "cli");
  assert.match(headers["User-Agent"] ?? "", /^claude-cli\//);
  assert.equal(
    headers["anthropic-beta"],
    "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07",
  );
  assert.equal(headers["x-api-key"], "spoofed");
});

test("Claude requests keep the client's own identity headers and fall back to defaults", () => {
  const auth = { key: "sk-ant-oat01-a", headers: signInHeaders("claude", { access: "a", refresh: "r", accountId: "", residency: "" }) };
  const forwarded = upstreamHeaders(claudeDep, auth, {
    "user-agent": "claude-cli/2.1.300 (external, cli)",
    "x-app": "cli",
    "anthropic-version": "2023-06-01",
    "x-stainless-lang": "js",
  });
  assert.equal(forwarded["user-agent"], "claude-cli/2.1.300 (external, cli)");
  assert.equal(forwarded["User-Agent"], undefined);
  assert.equal(forwarded["x-stainless-lang"], "js");
  assert.equal(forwarded.Authorization, "Bearer sk-ant-oat01-a");
  const fallback = upstreamHeaders(claudeDep, auth);
  assert.match(fallback["User-Agent"] ?? "", /^claude-cli\//);
});

test("Non-Anthropic upstreams receive only the client's Anthropic beta header and a policy version", () => {
  const client = {
    "anthropic-version": "2026-10-21",
    "anthropic-beta": "context-1m-2025-08-07",
    "user-agent": "claude-cli/2.1.300 (external, cli)",
    "x-stainless-lang": "js",
  };
  const headers = upstreamHeaders({ ...claudeDep, kind: "openai" }, { key: "sk-x", headers: {} }, client);
  assert.equal(headers["anthropic-version"], undefined);
  assert.equal(headers["anthropic-beta"], "context-1m-2025-08-07");
  assert.equal(headers["user-agent"], undefined);
  assert.equal(headers["x-stainless-lang"], undefined);
  const kimi = upstreamHeaders({ ...claudeDep, kind: "kimi" }, { key: "sk-kimi", headers: {} }, client);
  assert.equal(kimi["anthropic-version"], "2023-06-01");
  assert.equal(kimi["anthropic-beta"], "context-1m-2025-08-07");
  assert.equal(kimi["user-agent"], undefined);
});

test("API key Anthropic deployments keep x-api-key and no OAuth betas", () => {
  const headers = upstreamHeaders({ ...claudeDep, kind: "anthropic" }, { key: "sk-ant-api", headers: {} });
  assert.equal(headers["x-api-key"], "sk-ant-api");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["anthropic-beta"], undefined);
});

test("Claude bodies start with the Claude Code identity and keep the caller system prompt", () => {
  const converted = prepareBody(claudeDep, "/chat/completions", {
    model: "alias",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ],
    fallbacks: ["other"],
  });
  assert.equal(converted.model, "claude-sonnet-4-5");
  assert.equal("fallbacks" in converted, false);
  const system = converted.system as { type: string; text: string }[];
  assert.equal(system[0]!.text, CLAUDE_CODE_IDENTITY);
  assert.equal(system.at(-1)!.text, "Be brief.");

  const native = prepareBody(claudeDep, "/v1/messages", { model: "alias", max_tokens: 5, system: "Be brief.", messages: [] });
  assert.deepEqual(
    (native.system as { text: string }[]).map((block) => block.text),
    [CLAUDE_CODE_IDENTITY, "Be brief."],
  );
  assert.equal("system" in prepareBody({ ...claudeDep, kind: "anthropic" }, "/v1/messages", { messages: [] }), false);
});

test("native Claude Code requests reach the subscription untouched", () => {
  const system = [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.303.e6f; cc_entrypoint=cli;" },
    { type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: { type: "ephemeral" } },
    { type: "text", text: "Project instructions", cache_control: { type: "ephemeral" } },
  ];
  const body = { model: "alias", max_tokens: 5, system, messages: [{ role: "user", content: "hi" }] };
  const native = prepareBody(claudeDep, "/v1/messages", body);
  assert.equal(native.system, system);
  assert.deepEqual(native.system, structuredClone(system));
  const sdk = [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }];
  assert.equal(withClaudeIdentity({ system: sdk }).system, sdk);
  const sdkCli = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
  assert.equal(withClaudeIdentity({ system: sdkCli }).system, sdkCli);
  const other = withClaudeIdentity({ system: [{ type: "text", text: "Be brief." }] }).system as { text: string }[];
  assert.deepEqual(
    other.map((block) => block.text),
    [CLAUDE_CODE_IDENTITY, "Be brief."],
  );
});

test("the Claude Code identity is not duplicated", () => {
  const once = withClaudeIdentity({ system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }, { type: "text", text: "x" }] });
  assert.equal((once.system as unknown[]).length, 2);
  assert.equal((withClaudeIdentity({}).system as unknown[]).length, 1);
});

test("OAuth betas are always present exactly once", () => {
  assert.equal(
    withClaudeBetas({ "Anthropic-Beta": "oauth-2025-04-20,x" })["anthropic-beta"],
    "claude-code-20250219,oauth-2025-04-20,x",
  );
  assert.equal(withClaudeBetas({ "Content-Type": "application/json" })["Content-Type"], "application/json");
});

test("Anthropic rate limit headers park the route until the unified reset", () => {
  const headers = new Headers({ "anthropic-ratelimit-unified-reset": "1900000000" });
  assert.equal(upstreamRetryAt(429, { type: "error" }, 0, headers), 1_900_000_000_000);
  assert.equal(upstreamRetryAt(500, {}, 0, headers), null);
  assert.equal(upstreamError(429, { error: { message: "limit" } }, headers).retryAt, 1_900_000_000_000);
  assert.equal(upstreamError(429, { error: { message: "limit" } }).retryAt, null);
});

test("only a rejected five-hour or weekly window parks the account until its reset", () => {
  const now = 1_899_990_000_000;
  const fiveHour = String(1_900_000_000);
  const weekly = String(1_900_400_000);
  const none = () => 0;
  const rejected5h = new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": fiveHour,
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-reset": weekly,
    "anthropic-ratelimit-unified-reset": fiveHour,
    "retry-after": "30",
  });
  assert.equal(upstreamRetryAt(429, {}, now, rejected5h, none), 1_900_000_000_000);
  const rejectedWeek = new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "seven_day",
    "anthropic-ratelimit-unified-reset": weekly,
  });
  assert.equal(upstreamRetryAt(429, {}, now, rejectedWeek, none), 1_900_400_000_000);
  const throttled = new Headers({
    "anthropic-ratelimit-unified-status": "allowed_warning",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-reset": fiveHour,
    "retry-after": "30",
  });
  assert.equal(upstreamRetryAt(429, {}, now, throttled, none), now + 30_000);
  const overageOnly = new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "overage",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-reset": weekly,
    "retry-after": "12",
  });
  assert.equal(upstreamRetryAt(429, {}, now, overageOnly, none), now + 12_000);
  assert.equal(upstreamRetryAt(429, {}, now, new Headers({ "anthropic-ratelimit-unified-status": "allowed" }), none), null);
});

test("a rejected Fable limit parks the request until the Fable reset, and only a Fable claim does", () => {
  const now = 1_899_990_000_000;
  const fable = String(1_900_300_000);
  const none = () => 0;
  const claimed = new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-reset": fable,
    "retry-after": "12",
  });
  assert.equal(upstreamRetryAt(429, {}, now, claimed, none), 1_900_300_000_000);
  const refusal = upstreamError(
    429,
    {
      type: "error",
      error: { type: "rate_limit_error", message: "Fable limit reached. Turn on usage credits.", details: { error_code: "credits_required" } },
    },
    claimed,
  );
  assert.equal(refusal.requestScoped, false);
  assert.equal(refusal.retryAt, 1_900_300_000_000);
  const unclaimed = new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d_oi-status": "rejected",
    "anthropic-ratelimit-unified-7d_oi-reset": fable,
    "retry-after": "12",
  });
  assert.equal(upstreamRetryAt(429, {}, now, unclaimed, none), 1_900_300_000_000);
  const throttled = new Headers({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-7d_oi-status": "rejected",
    "anthropic-ratelimit-unified-7d_oi-reset": fable,
    "retry-after": "30",
  });
  assert.equal(upstreamRetryAt(429, {}, now, throttled, none), now + 30_000);
  const overage = new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "overage",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d_oi-status": "rejected",
    "anthropic-ratelimit-unified-7d_oi-reset": fable,
    "retry-after": "12",
  });
  assert.equal(upstreamRetryAt(429, {}, now, overage, none), now + 12_000);
  const lapsed = new Headers(claimed);
  lapsed.set("anthropic-ratelimit-unified-reset", String(Math.floor(now / 1000) - 10));
  assert.equal(upstreamRetryAt(429, {}, now, lapsed, none), now + 12_000);
});

test("a Fable rejection on any response names the full Fable window and leaves the plan windows alone", () => {
  const fable = 1_900_300_000;
  const reached = {
    key: "iguana_necktie",
    scope: "Fable",
    usedPercent: 100,
    windowSeconds: 604_800,
    resetsAt: new Date(fable * 1000).toISOString(),
    limitReached: true,
  };
  const claimed = new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-reset": String(fable),
  });
  assert.deepEqual(claudeModelLimitReached(claimed), reached);
  assert.deepEqual(claudeHeaderWindows(claimed), []);
  const sonnet = new Headers({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.2",
    "anthropic-ratelimit-unified-7d-utilization": "0.4",
    "anthropic-ratelimit-unified-7d_oi-status": "rejected",
    "anthropic-ratelimit-unified-7d_oi-reset": String(fable),
    "anthropic-ratelimit-unified-reset": String(fable - 3_600),
  });
  assert.deepEqual(claudeModelLimitReached(sonnet), reached);
  assert.deepEqual(
    claudeHeaderWindows(sonnet).map((window) => [window.scope, window.usedPercent, window.limitReached]),
    [["", 20, false], ["", 40, false]],
  );
  const unknownReset = new Headers({ "anthropic-ratelimit-unified-7d_oi-status": "rejected" });
  assert.equal(claudeModelLimitReached(unknownReset)?.resetsAt, null);
  assert.equal(
    claudeModelLimitReached(
      new Headers({ "anthropic-ratelimit-unified-7d_oi-utilization": "0.99", "anthropic-ratelimit-unified-7d_oi-status": "allowed" }),
    ),
    null,
  );
  assert.equal(
    claudeModelLimitReached(
      new Headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "five_hour" }),
    ),
    null,
  );
});

test("Retry-After drives short throttles with a little jitter on every provider", () => {
  const now = 1_000_000;
  const apiKey = new Headers({ "retry-after": "20", "anthropic-ratelimit-requests-reset": "2026-10-21T00:00:00Z" });
  assert.equal(upstreamRetryAt(429, { type: "error" }, now, apiKey, () => 0), now + 20_000);
  const jittered = upstreamRetryAt(429, { type: "error" }, now, apiKey, () => 0.999)!;
  assert.ok(jittered > now + 20_000 && jittered <= now + 24_000);
  assert.equal(upstreamRetryAt(429, {}, now, new Headers({ "retry-after-ms": "1500" }), () => 0), now + 1_500);
  assert.equal(upstreamRetryAt(429, { error: { resets_in_seconds: 90 } }, now, apiKey, () => 0), now + 90_000);
  assert.equal(upstreamRetryAt(503, {}, now, new Headers({ "retry-after": "7" }), () => 0), now + 7_000);
  assert.equal(upstreamRetryAt(529, {}, now, new Headers({ "retry-after": "2" }), () => 0), now + 2_000);
  assert.equal(upstreamRetryAt(500, {}, now, new Headers({ "retry-after": "2" }), () => 0), null);
  assert.equal(upstreamRetryAt(400, {}, now, apiKey, () => 0), null);
});

test("fast mode and long context entitlement refusals belong to the request, not the account", async () => {
  const { gateResponse } = await import("@/lib/gateway/access/gate");
  const refusal = upstreamError(
    429,
    { type: "error", error: { type: "rate_limit_error", message: "Fast mode requires usage credits. Turn on extra usage." } },
    new Headers({ "retry-after": "60" }),
  );
  assert.equal(refusal.requestScoped, true);
  assert.equal(refusal.retryAt, null);
  const longContext = upstreamError(
    429,
    { type: "error", error: { type: "rate_limit_error", message: "Extra usage is required for long context requests." } },
    new Headers({ "retry-after": "60", "anthropic-ratelimit-unified-status": "allowed" }),
  );
  assert.equal(longContext.requestScoped, true);
  assert.equal(longContext.retryAt, null);
  const scoped = gateResponse(longContext, new Request("http://hub.local/api/subscription/v1/messages", { method: "POST" }));
  assert.equal(scoped.status, 429);
  assert.equal(scoped.headers.get("retry-after"), null);
  assert.equal(scoped.headers.get("x-should-retry"), "false");
  const throttle = upstreamError(429, { type: "error", error: { message: "Rate limited" } }, new Headers({ "retry-after": "8" }));
  assert.equal(throttle.requestScoped, false);
  const response = gateResponse(throttle, new Request("http://hub.local/api/v1/messages", { method: "POST" }));
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) >= 8);
  assert.equal(response.headers.get("x-should-retry"), "true");
  const overloaded = gateResponse(
    upstreamError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, new Headers({ "retry-after": "4" })),
    new Request("http://hub.local/api/v1/messages", { method: "POST" }),
  );
  assert.equal(overloaded.status, 529);
  assert.ok(Number(overloaded.headers.get("retry-after")) >= 4);
  assert.equal(((await overloaded.json()) as { error: { type: string } }).error.type, "overloaded_error");
});

const FIVE_HOURS = 18_000;
const WEEK = 604_800;
const RESET_5H = 1_900_000_000;
const RESET_7D = 1_900_400_000;

function unified(values: Record<string, string>): Headers {
  return new Headers(
    Object.fromEntries(Object.entries(values).map(([name, value]) => [`anthropic-ratelimit-unified-${name}`, value])),
  );
}

function planWindow(windowSeconds: number, usedPercent: number, resetsAt: string | null, limitReached = false): LimitWindow {
  return { scope: "", usedPercent, windowSeconds, resetsAt, limitReached };
}

function fullLimits(fetchedAt: number): SubscriptionLimits {
  return {
    plan: "max",
    windows: [
      planWindow(FIVE_HOURS, 10, new Date(RESET_5H * 1000).toISOString()),
      planWindow(WEEK, 20, new Date(RESET_7D * 1000).toISOString()),
      { scope: "Opus", usedPercent: 70, windowSeconds: WEEK, resetsAt: null, limitReached: false },
    ],
    credits: null,
    resetCredits: null,
    extraUsage: { usedCents: 120, limitCents: 5_000, percent: 2.4 },
    fetchedAt: new Date(fetchedAt).toISOString(),
  };
}

test("unified rate limit headers become the five-hour and weekly plan windows", () => {
  const windows = claudeHeaderWindows(
    unified({
      status: "allowed_warning",
      reset: String(RESET_5H),
      "representative-claim": "five_hour",
      "5h-utilization": "0.42",
      "5h-reset": String(RESET_5H),
      "5h-status": "allowed",
      "7d-utilization": "0.875",
      "7d-reset": String(RESET_7D * 1000),
      "7d-status": "allowed_warning",
      "7d_oi-utilization": "0.99",
      "overage-status": "rejected",
    }),
  );
  assert.deepEqual(windows, [
    planWindow(FIVE_HOURS, 42, new Date(RESET_5H * 1000).toISOString()),
    planWindow(WEEK, 87.5, new Date(RESET_7D * 1000).toISOString()),
  ]);
});

test("rejected headers mark the claimed window reached and odd or missing values are ignored", () => {
  const rejected = claudeHeaderWindows(
    unified({ status: "rejected", reset: String(RESET_5H), "representative-claim": "five_hour", "7d-utilization": "0.3" }),
  );
  assert.deepEqual(rejected, [
    planWindow(FIVE_HOURS, 100, new Date(RESET_5H * 1000).toISOString(), true),
    planWindow(WEEK, 30, null),
  ]);
  const weekly = claudeHeaderWindows(
    unified({ "5h-utilization": "0.2", "7d-utilization": "1", "7d-status": "rejected", "7d-reset": "2031-03-17T12:00:00Z" }),
  );
  assert.equal(weekly[1]?.limitReached, true);
  assert.equal(weekly[1]?.usedPercent, 100);
  assert.equal(weekly[1]?.resetsAt, "2031-03-17T12:00:00.000Z");
  assert.equal(weekly[0]?.limitReached, false);
  assert.deepEqual(claudeHeaderWindows(new Headers()), []);
  assert.deepEqual(claudeHeaderWindows(unified({ status: "allowed", reset: String(RESET_5H) })), []);
  assert.deepEqual(
    claudeHeaderWindows(unified({ "5h-utilization": "42", "7d-utilization": "-0.1", "5h-reset": "soon" })),
    [],
  );
  assert.equal(claudeHeaderWindows(unified({ "5h-utilization": "0.5", "5h-reset": "later" }))[0]?.resetsAt, null);
});

test("observed windows replace only the plan windows and keep model limits, extra usage, and plan", () => {
  const now = RESET_5H * 1000 - 3_600_000;
  const base = fullLimits(now - 600_000);
  const merged = withObservedWindows(base, [planWindow(FIVE_HOURS, 55, null), planWindow(WEEK, 21, null)], now);
  assert.equal(merged.plan, "max");
  assert.deepEqual(merged.extraUsage, base.extraUsage);
  assert.equal(merged.fetchedAt, base.fetchedAt);
  assert.equal(merged.observedAt, new Date(now).toISOString());
  assert.deepEqual(
    merged.windows.map((window) => [window.scope, window.windowSeconds, window.usedPercent, window.resetsAt]),
    [
      ["", FIVE_HOURS, 55, base.windows[0]!.resetsAt],
      ["", WEEK, 21, base.windows[1]!.resetsAt],
      ["Opus", WEEK, 70, null],
    ],
  );
  assert.equal(limitsUpdatedAt(merged), now);
  assert.equal(updatedFromTraffic(merged), true);
  assert.equal(updatedFromTraffic(base), false);
  const empty = withObservedWindows({ ...base, windows: [] }, [planWindow(WEEK, 5, null)], now);
  assert.deepEqual(empty.windows, [planWindow(WEEK, 5, null)]);
});

test("only real movement in the observed windows counts as a change", () => {
  const reset = new Date(RESET_5H * 1000).toISOString();
  const before = [planWindow(FIVE_HOURS, 40, reset), planWindow(WEEK, 20, null)];
  assert.equal(observedChanged(before, [planWindow(FIVE_HOURS, 40.6, reset)]), false);
  assert.equal(observedChanged(before, [planWindow(FIVE_HOURS, 41, reset)]), true);
  assert.equal(observedChanged(before, [planWindow(FIVE_HOURS, 40, new Date(RESET_5H * 1000 + 30_000).toISOString())]), false);
  assert.equal(observedChanged(before, [planWindow(FIVE_HOURS, 40, new Date(RESET_5H * 1000 + 3_600_000).toISOString())]), true);
  assert.equal(observedChanged(before, [planWindow(WEEK, 20, reset)]), true);
  assert.equal(observedFlipped(before, [planWindow(FIVE_HOURS, 40, reset, true)]), true);
  assert.equal(observedFlipped(before, [planWindow(FIVE_HOURS, 90, reset)]), false);
  assert.equal(observedFlipped([], [planWindow(FIVE_HOURS, 1, null)]), true);
});

test("a newer full read wins but keeps plan windows observed after it", () => {
  const t0 = 1_800_000_000_000;
  const older = withObservedWindows(
    fullLimits(t0),
    [planWindow(FIVE_HOURS, 80, null), planWindow(WEEK, 26, null)],
    t0 + 120_000,
  );
  const polled = {
    ...fullLimits(t0 + 60_000),
    windows: [
      planWindow(FIVE_HOURS, 60, null),
      planWindow(WEEK, 25, null),
      { scope: "Opus", usedPercent: 90, windowSeconds: WEEK, resetsAt: null, limitReached: false },
    ],
  };
  const combined = newestLimits(older, polled);
  assert.equal(combined.fetchedAt, polled.fetchedAt);
  assert.equal(combined.observedAt, older.observedAt);
  assert.deepEqual(
    combined.windows.map((window) => window.usedPercent),
    [80, 26, 90],
  );
  const later = fullLimits(t0 + 180_000);
  assert.equal(newestLimits(older, later), later);
  assert.equal(newestLimits(later, older), later);
  assert.equal(newestLimits(fullLimits(t0), fullLimits(t0 - 1)).fetchedAt, new Date(t0).toISOString());
});

test("a Fable rejection marks the Fable window full once, keeps every other window, and blocks only Fable models", () => {
  const t0 = 1_899_990_000_000;
  const reset = new Date(t0 + 50 * 3_600_000).toISOString();
  const reached: LimitWindow = { key: "iguana_necktie", scope: "Fable", usedPercent: 100, windowSeconds: WEEK, resetsAt: reset, limitReached: true };
  const base = fullLimits(t0);
  const added = withModelLimitReached(base, reached, t0);
  assert.ok(added);
  assert.deepEqual(added.windows, [...base.windows, reached]);
  assert.equal(added.fetchedAt, base.fetchedAt);
  assert.equal(added.extraUsage, base.extraUsage);
  assert.equal(withModelLimitReached(added, reached, t0), null);
  assert.equal(withModelLimitReached(added, { ...reached, resetsAt: null }, t0), null);
  assert.ok(quotaExhausted(added, "claude-fable-5-2", t0));
  assert.ok(quotaExhausted(added, "claude-fable-5-2[1m]", t0));
  assert.equal(quotaExhausted(added, "claude-sonnet-5-5", t0), false);
  assert.equal(quotaExhausted(added, "claude-opus-5-5", t0), false);
  assert.equal(modelRecoveryAt(added, "claude-fable-5-2", t0), Date.parse(reset));
  assert.equal(modelRecoveryAt(added, "claude-sonnet-5-5", t0), null);
  const polledWindow: LimitWindow = {
    key: "weekly_scoped",
    scope: "Fable",
    usedPercent: 96,
    windowSeconds: WEEK,
    resetsAt: reset,
    limitReached: false,
    usedPercentOfWeekly: 30,
  };
  const polled = { ...base, windows: [...base.windows, polledWindow] };
  const marked = withModelLimitReached(polled, { ...reached, resetsAt: null }, t0);
  assert.deepEqual(marked?.windows, [...base.windows, { ...polledWindow, usedPercent: 100, limitReached: true }]);
  const moved = withModelLimitReached(added, { ...reached, resetsAt: new Date(t0 + 60 * 3_600_000).toISOString() }, t0);
  assert.equal(moved?.windows.at(-1)?.resetsAt, new Date(t0 + 60 * 3_600_000).toISOString());
  const lapsed = { ...base, windows: [...base.windows, { ...reached, resetsAt: new Date(t0 - 1_000).toISOString() }] };
  assert.equal(withModelLimitReached(lapsed, reached, t0)?.windows.at(-1)?.resetsAt, reset);
  const pool: LimitWindow = { key: "iguana_necktie", scope: "Cloud sessions", usedPercent: 40, windowSeconds: 0, resetsAt: null, limitReached: false };
  const credits = withModelLimitReached({ ...base, windows: [pool] }, reached, t0);
  assert.deepEqual(credits?.windows, [pool, reached]);
});
