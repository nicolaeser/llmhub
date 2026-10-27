import { gateway, resetGateway } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { KICKOFF_IDLE_RETRY_MS, KICKOFF_RESET_GRACE_MS, windowKickoffDue } from "@/lib/gateway/routing/quota";
import { sealTokens } from "@/lib/gateway/upstreams/credentials";
import type { JsonMap } from "@/types/gateway";
import type { LimitWindow, SubscriptionLimits } from "@/types/providers";

const ALIAS = "claude-haiku";
const ACCOUNT = "provider-claude-kickoff";
const NOW = Date.parse("2026-10-27T12:00:00Z");
const HOUR = 3_600_000;

type Snapshot = { limits: SubscriptionLimits | null; fetchedAt: Date | null; kickoffAt: Date | null };

let snapshot: Snapshot;
let kickoffModel = ALIAS;

function window(over: Partial<LimitWindow>): LimitWindow {
  return { scope: "", usedPercent: 0, windowSeconds: 18_000, resetsAt: null, limitReached: false, ...over };
}

function limits(windows: LimitWindow[], fetchedAt = NOW): SubscriptionLimits {
  return {
    plan: "max",
    windows,
    credits: null,
    resetCredits: null,
    extraUsage: null,
    fetchedAt: new Date(fetchedAt).toISOString(),
  };
}

function at(time: number): string {
  return new Date(time).toISOString();
}

function claudeGroup() {
  return {
    alias: ALIAS,
    enabled: true,
    vendor: "anthropic",
    displayName: "",
    strategy: "priority",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    priceWindows: [],
    overflowGroup: "",
    numRetries: 0,
    fallbackGroups: [],
    autoRoutes: null,
    deployments: [
      {
        id: `${ALIAS}-route`,
        kind: "claude",
        baseUrl: "",
        model: "claude-haiku-4-5",
        weight: 1,
        costInput: 0,
        costOutput: 0,
        providerId: ACCOUNT,
        provider: {
          id: ACCOUNT,
          kind: "claude",
          baseUrl: "",
          apiKey: "",
          zdr: false,
          retentionDays: null,
          region: "",
          noTraining: false,
          enabled: true,
          restricted: false,
          assignments: [],
          login: { status: "active" },
        },
      },
    ],
  };
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function messageCalls() {
  return gateway.upstream.filter((call) => call.url.includes("/v1/messages"));
}

beforeEach(() => {
  resetGateway();
  gateway.groups.set(ALIAS, claudeGroup());
  kickoffModel = ALIAS;
  snapshot = {
    limits: limits([
      window({ usedPercent: 40, resetsAt: at(NOW - 2 * 60_000) }),
      window({ usedPercent: 30, windowSeconds: 604_800, resetsAt: at(NOW + 72 * HOUR) }),
    ]),
    fetchedAt: new Date(NOW - 5 * 60_000),
    kickoffAt: null,
  };
  recordedPrisma.handlers = {
    accountRouting: {
      findMany: () => (kickoffModel ? [{ kind: "claude", kickoffModel }] : []),
    },
    providerConnection: {
      findMany: () => [{ id: ACCOUNT, kind: "claude", limitSnapshot: { ...snapshot } }],
    },
    providerLimitSnapshot: {
      updateMany: ({ where, data }: { where: { kickoffAt?: Date | null }; data: { kickoffAt?: Date } }) => {
        if (!data.kickoffAt) return { count: 0 };
        if (!sameTime(where.kickoffAt ?? null, snapshot.kickoffAt)) return { count: 0 };
        snapshot.kickoffAt = data.kickoffAt;
        return { count: 1 };
      },
    },
    providerLogin: {
      findUnique: () => ({
        providerId: ACCOUNT,
        account: "test-account",
        plan: "Max",
        tokens: sealTokens({ access: "sk-ant-oat-kickoff", refresh: "refresh-test", accountId: "", residency: "" }),
        expiresAt: new Date(Date.now() + HOUR),
        status: "active",
        version: 1,
      }),
    },
  };
  gateway.reply = (call) =>
    call.url.includes("/v1/messages")
      ? Response.json({
          id: "msg_kickoff",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 6, output_tokens: 1 },
        })
      : Response.json({});
});

test("a window is due for a kickoff once its reset has passed, and only once for that reset", () => {
  const reset = NOW - 2 * 60_000;
  const passed = limits([window({ usedPercent: 40, resetsAt: at(reset) })]);
  assert.equal(windowKickoffDue(passed, "claude-haiku-4-5", null, NOW), true);
  assert.equal(windowKickoffDue(passed, "claude-haiku-4-5", reset - HOUR, NOW), true);
  assert.equal(windowKickoffDue(passed, "claude-haiku-4-5", reset + 60_000, NOW), false);
  assert.equal(windowKickoffDue(passed, "claude-haiku-4-5", null, reset + KICKOFF_RESET_GRACE_MS - 1), false);
  const running = limits([window({ usedPercent: 40, resetsAt: at(NOW + HOUR) })]);
  assert.equal(windowKickoffDue(running, "claude-haiku-4-5", null, NOW), false);
});

test("a full window that has not reset blocks the kickoff, even when another window has reset", () => {
  const weeklyFull = limits([
    window({ usedPercent: 100, limitReached: true, resetsAt: at(NOW - 2 * 60_000) }),
    window({ usedPercent: 100, limitReached: true, windowSeconds: 604_800, resetsAt: at(NOW + 48 * HOUR) }),
  ]);
  assert.equal(windowKickoffDue(weeklyFull, "claude-haiku-4-5", null, NOW), false);
  const opusFull = limits([
    window({ usedPercent: 10, resetsAt: at(NOW - 2 * 60_000) }),
    window({ scope: "Opus", usedPercent: 100, limitReached: true, windowSeconds: 604_800, resetsAt: at(NOW + 48 * HOUR) }),
  ]);
  assert.equal(windowKickoffDue(opusFull, "claude-opus-4-1", null, NOW), false);
  assert.equal(windowKickoffDue(opusFull, "claude-haiku-4-5", null, NOW), true);
});

test("an unused plan window without a reset time is started at most once an hour", () => {
  const idle = limits([window({}), window({ scope: "Sonnet", windowSeconds: 604_800 })]);
  assert.equal(windowKickoffDue(idle, "claude-haiku-4-5", null, NOW), true);
  assert.equal(windowKickoffDue(idle, "claude-haiku-4-5", NOW - KICKOFF_IDLE_RETRY_MS + 1, NOW), false);
  assert.equal(windowKickoffDue(idle, "claude-haiku-4-5", NOW - KICKOFF_IDLE_RETRY_MS, NOW), true);
  const sonnetIdle = limits([window({ usedPercent: 20, resetsAt: at(NOW + HOUR) }), window({ scope: "Sonnet" })]);
  assert.equal(windowKickoffDue(sonnetIdle, "claude-sonnet-4-5", null, NOW), false);
});

test("the sweep pings an account whose window reset with the chosen model, once per reset", async () => {
  const { runWindowKickoffs } = await import("@/lib/providers/window-kickoff");
  assert.equal(await runWindowKickoffs(NOW), 1);
  const calls = messageCalls();
  assert.equal(calls.length, 1);
  const body = calls[0]!.body as JsonMap;
  assert.equal(body.model, "claude-haiku-4-5");
  assert.match(JSON.stringify(body.messages), /Only reply with ok\./);
  assert.equal(calls[0]!.headers.authorization, "Bearer sk-ant-oat-kickoff");
  assert.equal(snapshot.kickoffAt?.getTime(), NOW);
  for (let wait = 0; wait < 400 && !recordedPrisma.called("requestLog", "create").length; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const logged = recordedPrisma.called("requestLog", "create").map((call) => (call.args as { data: JsonMap }).data);
  assert.ok(logged.some((row) => row.endpoint === "internal:kickoff"));

  assert.equal(await runWindowKickoffs(NOW + 60_000), 0);
  assert.equal(messageCalls().length, 1);
});

test("the sweep leaves accounts alone without a kickoff model, at a limit, or before their reset", async () => {
  const { runWindowKickoffs } = await import("@/lib/providers/window-kickoff");
  kickoffModel = "";
  assert.equal(await runWindowKickoffs(NOW), 0);
  kickoffModel = ALIAS;
  snapshot.limits = limits([
    window({ usedPercent: 100, limitReached: true, resetsAt: at(NOW - 2 * 60_000) }),
    window({ usedPercent: 100, limitReached: true, windowSeconds: 604_800, resetsAt: at(NOW + 48 * HOUR) }),
  ]);
  assert.equal(await runWindowKickoffs(NOW), 0);
  snapshot.limits = limits([window({ usedPercent: 40, resetsAt: at(NOW + HOUR) })]);
  assert.equal(await runWindowKickoffs(NOW), 0);
  assert.equal(messageCalls().length, 0);
  assert.equal(snapshot.kickoffAt, null);
});
