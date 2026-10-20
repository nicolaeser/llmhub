import assert from "node:assert/strict";
import test from "node:test";
import { recordedPrisma } from "./support/recorded-prisma";
import type { LiveFeed, LiveTopic } from "@/types/live";
import type { LimitSnapshot } from "@/types/providers";
import type { SpendScope } from "@/types/structure";
import type { UpdaterSnapshot } from "@/types/updates";

const SNAPSHOT: UpdaterSnapshot = {
  build: { version: "v2026.10.20.abc1234", startedAt: "2026-10-20T09:00:00.000Z" },
  updater: null,
  updating: false,
};

type Counter = { state: number };

function counterFeed(
  topic: LiveTopic,
  permission: LiveFeed<Counter>["permission"],
  loads: SpendScope[],
): LiveFeed<Counter> & { bump: () => void } {
  let value = 1;
  return {
    topic,
    permission,
    pollMs: 60_000,
    minGapMs: 0,
    scopeKey: (scope) => `${scope.orgId ?? ""}|${scope.userId ?? ""}`,
    async load(scope) {
      loads.push(scope);
      return { state: value };
    },
    full: (state) => ({ at: 1, value: state.state, scope: "full" }),
    change: (previous, next) => (previous.state === next.state ? null : { at: 2, value: next.state }),
    bump: () => {
      value += 1;
    },
  };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, done: (text: string) => boolean) {
  const decoder = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  return text;
}

function snapshot(id: string, version: number, used = 10): LimitSnapshot {
  return {
    id,
    limits: {
      plan: "pro",
      windows: [{ scope: "", usedPercent: used, windowSeconds: 18_000, resetsAt: null, limitReached: false }],
      credits: null,
      resetCredits: null,
      extraUsage: null,
      fetchedAt: "2026-10-20T10:00:00.000Z",
    },
    error: "",
    version,
    checkedAt: "2026-10-20T10:00:00.000Z",
    nextAt: null,
    retryAt: null,
  };
}

test("the live stream only sends topics the viewer may read and revokes them when access changes", async () => {
  const { liveAccess, liveStream, sseEvent } = await import("@/lib/updates/live-stream");
  const loads: SpendScope[] = [];
  const limits = counterFeed("limits", "providers:read", loads);
  const usage = counterFeed("usage", "spend:read", loads);
  const abort = new AbortController();
  let checks = 0;
  const reader = liveStream({
    sessionId: "session-live-1",
    access: liveAccess(["providers:read"], { orgId: "org-a" }),
    topics: ["limits", "usage"],
    signal: abort.signal,
    heartbeatMs: 15,
    accessCheckMs: 0,
    loadSnapshot: async () => SNAPSHOT,
    feeds: { limits, usage },
    checkAccess: async () => {
      checks += 1;
      return checks === 1 ? liveAccess(["providers:read"], { orgId: "org-a" }) : liveAccess(["spend:read"], { userId: "u1" });
    },
  }).getReader();
  const text = await readUntil(reader, (value) => value.includes("event: usage"));
  abort.abort();
  await readUntil(reader, () => false);
  const limitsFull = sseEvent("limits", JSON.stringify({ at: 1, value: 1, scope: "full" }));
  assert.ok(text.includes(limitsFull), text);
  assert.ok(text.indexOf(limitsFull) < text.indexOf('event: limits\ndata: {"revoked":true}'));
  assert.ok(text.includes(sseEvent("usage", JSON.stringify({ at: 1, value: 1, scope: "full" }))));
  assert.equal(text.split("event: usage").length - 1, 1);
  assert.deepEqual(loads, [{ orgId: "org-a" }, { userId: "u1" }]);
});

test("viewers without any topic permission get only status, pings, and no topic loads", async () => {
  const { liveAccess, liveStream } = await import("@/lib/updates/live-stream");
  const loads: SpendScope[] = [];
  const abort = new AbortController();
  const reader = liveStream({
    sessionId: "session-live-2",
    access: liveAccess(["keys:read"]),
    topics: ["limits", "requests", "usage"],
    signal: abort.signal,
    heartbeatMs: 10,
    loadSnapshot: async () => SNAPSHOT,
    feeds: {
      limits: counterFeed("limits", "providers:read", loads),
      requests: counterFeed("requests", "spend:read", loads),
      usage: counterFeed("usage", "spend:read", loads),
    },
  }).getReader();
  const text = await readUntil(reader, (value) => value.includes("event: ping"));
  abort.abort();
  await readUntil(reader, () => false);
  assert.match(text, /event: status/);
  assert.doesNotMatch(text, /event: (limits|requests|usage)/);
  assert.deepEqual(loads, []);
});

test("one feed load serves every subscriber of a scope, changes are pushed once, and idle channels stop", async () => {
  const { notifyLive, subscribeTopic, LIVE_NOTIFY_DELAY_MS } = await import("@/lib/updates/live-topics");
  const loads: SpendScope[] = [];
  const feed = counterFeed("requests", "spend:read", loads);
  const first: string[] = [];
  const second: string[] = [];
  const other: string[] = [];
  const stopFirst = subscribeTopic(feed, { orgId: "org-1" }, (json) => first.push(json));
  const stopSecond = subscribeTopic(feed, { orgId: "org-1" }, (json) => second.push(json));
  const stopOther = subscribeTopic(feed, { orgId: "org-2" }, (json) => other.push(json));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(loads.length, 2);
  assert.deepEqual(first, [JSON.stringify({ at: 1, value: 1, scope: "full" })]);
  assert.deepEqual(second, first);
  assert.deepEqual(other, first);
  notifyLive("requests");
  await new Promise((resolve) => setTimeout(resolve, LIVE_NOTIFY_DELAY_MS + 30));
  assert.equal(loads.length, 4);
  assert.equal(first.length, 1);
  feed.bump();
  notifyLive("requests");
  await new Promise((resolve) => setTimeout(resolve, LIVE_NOTIFY_DELAY_MS + 30));
  assert.deepEqual(first.slice(1), [JSON.stringify({ at: 2, value: 2 })]);
  assert.deepEqual(second.slice(1), first.slice(1));
  const late: string[] = [];
  const stopLate = subscribeTopic(feed, { orgId: "org-1" }, (json) => late.push(json));
  assert.deepEqual(late, [JSON.stringify({ at: 1, value: 2, scope: "full" })]);
  stopFirst();
  stopSecond();
  stopLate();
  stopOther();
  const settled = loads.length;
  notifyLive("requests");
  await new Promise((resolve) => setTimeout(resolve, LIVE_NOTIFY_DELAY_MS + 30));
  assert.equal(loads.length, settled);
});

test("the limits feed sends changed snapshots by version and removed accounts", async () => {
  const items = new Map<string, LimitSnapshot>([
    ["a", snapshot("a", 1)],
    ["b", snapshot("b", 3)],
  ]);
  recordedPrisma.reset({
    providerLimitSnapshot: {
      findMany: (args: { select?: { version?: boolean }; where?: { providerId?: { in: string[] } } }) => {
        if (args.select?.version) return [...items.values()].map((item) => ({ providerId: item.id, version: item.version }));
        return [...items.values()]
          .filter((item) => args.where?.providerId?.in.includes(item.id) ?? true)
          .map((item) => ({
            providerId: item.id,
            limits: item.limits,
            resets: null,
            resetsAt: null,
            error: item.error,
            fetchedAt: new Date(),
            checkedAt: new Date(),
            nextAt: new Date(),
            retryAt: null,
            failures: 0,
            loginVersion: 0,
            leaseUntil: null,
            version: item.version,
            provider: { kind: "grok_build", enabled: true },
          }));
      },
    },
  });
  const { LIMITS_FEED } = await import("@/lib/providers/limits-feed");
  const first = await LIMITS_FEED.load({}, null);
  const full = LIMITS_FEED.full(first) as { full: boolean; items: LimitSnapshot[] };
  assert.equal(full.full, true);
  assert.deepEqual(full.items.map((item) => [item.id, item.version]).sort(), [["a", 1], ["b", 3]]);
  const reads = () => recordedPrisma.called("providerLimitSnapshot", "findMany").length;
  const before = reads();
  assert.equal(await LIMITS_FEED.load({}, first), first);
  assert.equal(reads(), before + 1);
  assert.equal(LIMITS_FEED.change(first, first), null);
  items.set("a", snapshot("a", 2, 90));
  items.delete("b");
  const next = await LIMITS_FEED.load({}, first);
  const delta = LIMITS_FEED.change(first, next) as { full: boolean; items: LimitSnapshot[]; removed: string[] };
  assert.equal(delta.full, false);
  assert.deepEqual(delta.items.map((item) => [item.id, item.version, item.limits?.windows[0]?.usedPercent]), [["a", 2, 90]]);
  assert.deepEqual(delta.removed, ["b"]);
});

test("the browser keeps the newest snapshot per account, honours removals, and merges the action seed", async () => {
  const { applyLimitsEvent, mergeLimits, withLimitItems } = await import("@/lib/updates/live-events");
  const full = applyLimitsEvent(null, { at: 100, full: true, items: [snapshot("a", 2), snapshot("b", 1)], removed: [] });
  assert.deepEqual(Object.keys(full?.items ?? {}).sort(), ["a", "b"]);
  const stale = applyLimitsEvent(full, { at: 110, full: false, items: [snapshot("a", 1, 99)], removed: [] });
  assert.equal(stale?.items.a?.version, 2);
  const moved = applyLimitsEvent(stale, { at: 120, full: false, items: [snapshot("a", 3, 50)], removed: ["b"] });
  assert.equal(moved?.items.a?.limits?.windows[0]?.usedPercent, 50);
  assert.equal(moved?.items.b, undefined);
  assert.equal(moved?.removed.b, 120);
  const reconnected = applyLimitsEvent(moved, { at: 130, full: true, items: [snapshot("a", 2)], removed: [] });
  assert.equal(reconnected?.items.a?.version, 3);
  assert.equal(applyLimitsEvent(moved, { nonsense: true }), moved);
  assert.equal(applyLimitsEvent(moved, { at: 140, full: false, items: [{ id: "x" }, null], removed: [7] })?.items.x, undefined);

  const seed = { at: 115, items: [snapshot("a", 2), snapshot("b", 1), snapshot("c", 4)] };
  const merged = mergeLimits(seed, moved);
  assert.equal(merged.a?.version, 3);
  assert.equal(merged.b, undefined);
  assert.equal(merged.c?.version, 4);
  assert.equal(mergeLimits({ ...seed, at: 125 }, moved).b?.version, 1);
  assert.deepEqual(Object.keys(mergeLimits(null, null)), []);
  const refreshed = withLimitItems(seed, [snapshot("c", 5, 1), snapshot("a", 1)]);
  assert.deepEqual(refreshed.items.map((item) => [item.id, item.version]), [["a", 2], ["b", 1], ["c", 5]]);
});

test("topic lists, live URLs, and other topic payloads are parsed strictly", async () => {
  const { applyLiveEvent, liveUrl, newestOf, parseLiveTopics, usageTodayOf } = await import("@/lib/updates/live-events");
  assert.deepEqual(parseLiveTopics("usage, limits,limits,secrets"), ["limits", "usage"]);
  assert.deepEqual(parseLiveTopics(null), []);
  assert.equal(liveUrl("/internal-api/live", []), "/internal-api/live");
  assert.equal(liveUrl("/internal-api/live", ["usage", "limits"]), "/internal-api/live?topics=limits,usage");
  const today = { at: 5, day: "2026-10-20", spend: 1.5, requests: 3, errors: 1, tokens: 900 };
  assert.deepEqual(usageTodayOf(today), today);
  assert.equal(usageTodayOf({ ...today, spend: "1.5" }), null);
  assert.deepEqual(applyLiveEvent("usage", null, today), today);
  assert.equal(applyLiveEvent("usage", today, { revoked: true }), null);
  assert.deepEqual(applyLiveEvent("requests", null, { at: 9, requestId: "r1", requestAt: "x", auditId: null }), {
    at: 9,
    requestId: "r1",
    requestAt: "x",
    auditId: null,
    auditAt: null,
  });
  assert.equal(newestOf(today, { ...today, at: 4, requests: 1 }), today);
  assert.equal(newestOf(today, { ...today, at: 6, requests: 4 })?.requests, 4);
});

test("the browser store only keeps topics someone watches and tells the connection when the set changes", async () => {
  const { liveTopicValue, onWantedLiveTopics, receiveLiveEvent, wantedLiveTopics, watchLiveTopic } = await import(
    "@/lib/updates/live-client"
  );
  let changes = 0;
  let notified = 0;
  const stopTopics = onWantedLiveTopics(() => {
    changes += 1;
  });
  receiveLiveEvent("usage", { at: 1, day: "2026-10-20", spend: 0, requests: 1, errors: 0, tokens: 0 });
  assert.equal(liveTopicValue("usage"), null);
  const stopA = watchLiveTopic("usage", () => {
    notified += 1;
  });
  const stopB = watchLiveTopic("usage", () => undefined);
  assert.deepEqual(wantedLiveTopics(), ["usage"]);
  assert.equal(changes, 1);
  receiveLiveEvent("usage", { at: 2, day: "2026-10-20", spend: 0, requests: 2, errors: 0, tokens: 0 });
  assert.equal(liveTopicValue("usage")?.requests, 2);
  assert.equal(notified, 1);
  stopA();
  assert.equal(changes, 1);
  stopB();
  assert.equal(changes, 2);
  assert.deepEqual(wantedLiveTopics(), []);
  assert.equal(liveTopicValue("usage"), null);
  stopTopics();
});
