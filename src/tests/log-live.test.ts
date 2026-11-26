import assert from "node:assert/strict";
import test from "node:test";
import {
  activityMatches,
  liveKeyUsageOf,
  liveRowsOf,
  liveRunningOf,
  liveSince,
  LOG_LIVE_BACKFILL_MS,
  logLiveUrl,
  mergeLiveRows,
  runningMatches,
  usageRatio,
} from "@/lib/gateway/request-logs/log-live";
import { parseLogFilters } from "@/lib/gateway/request-logs/request-log-query";
import type { Principal, RequestTrace } from "@/types/gateway";
import type { KeyBudgetUsage, RequestActivity, RequestLogRow } from "@/types/logs";
import type { SpendScope } from "@/types/structure";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");

function row(id: string, createdAt: string, extra: Partial<RequestLogRow> = {}): RequestLogRow {
  return {
    id,
    createdAt,
    model: "claude-sonnet-5-5",
    endpoint: "/v1/messages",
    stream: true,
    status: 200,
    outcome: "success",
    latencyMs: 1200,
    keyId: "key-a",
    keyLabel: "Agent key",
    userId: "user-a",
    userLabel: "ada",
    memberId: "",
    memberLabel: "",
    teamId: "",
    orgId: "org-a",
    projectId: "",
    promptTokens: 10,
    completionTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0.01,
    piiMode: "",
    piiInput: [],
    piiOutput: [],
    guardInput: [],
    guardOutput: [],
    labels: [],
    hasContent: true,
    contentSkip: "",
    system: "",
    sessionId: "sess-1",
    agent: "claude_code",
    ...extra,
  };
}

function activity(kind: RequestActivity["kind"], extra: Partial<RequestActivity> = {}): RequestActivity {
  return { kind, orgId: "org-a", userId: "user-a", keyId: "key-a", sessionId: "sess-1", ...extra };
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

function eventsOf(text: string, name: string): unknown[] {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith(`event: ${name}\n`))
    .map((block) => JSON.parse(block.slice(block.indexOf("data: ") + 6)));
}

test("liveSince clamps the resume point to the backfill window", () => {
  assert.equal(liveSince(null, NOW), NOW);
  assert.equal(liveSince("not a date", NOW), NOW);
  assert.equal(liveSince(new Date(NOW - 60_000).toISOString(), NOW), NOW - 60_000);
  assert.equal(liveSince(new Date(NOW - 3_600_000).toISOString(), NOW), NOW - LOG_LIVE_BACKFILL_MS);
  assert.equal(liveSince(new Date(NOW + 60_000).toISOString(), NOW), NOW);
});

test("logLiveUrl carries the log filters and the resume point", () => {
  const url = logLiveUrl(parseLogFilters({ keyId: "key-a", session: "sess 1" }), "2026-11-25T12:00:00.000Z");
  const parsed = new URL(url, "https://hub.example");
  assert.equal(parsed.pathname, "/internal-api/logs/live");
  assert.equal(parsed.searchParams.get("keyId"), "key-a");
  assert.equal(parsed.searchParams.get("session"), "sess 1");
  assert.equal(parsed.searchParams.get("since"), "2026-11-25T12:00:00.000Z");
  assert.equal(logLiveUrl(parseLogFilters({}), null), "/internal-api/logs/live");
});

test("activityMatches keeps the viewer's spend scope and the page filters", () => {
  const none = parseLogFilters({});
  assert.equal(activityMatches(none, {}, activity("row")), true);
  assert.equal(activityMatches(none, { orgId: "org-b" }, activity("row")), false);
  assert.equal(activityMatches(none, { userId: "user-b" }, activity("row")), false);
  assert.equal(activityMatches(parseLogFilters({ keyId: "key-b" }), {}, activity("row")), false);
  assert.equal(activityMatches(parseLogFilters({ session: "sess-2" }), {}, activity("row")), false);
  assert.equal(activityMatches(parseLogFilters({ session: "sess-1", keyId: "key-a" }), { orgId: "org-a" }, activity("row")), true);
});

test("runningMatches hides running requests when a filter needs a finished result", () => {
  const entry = { ...activity("start"), model: "claude-sonnet-5-5", endpoint: "/v1/messages" };
  assert.equal(runningMatches(parseLogFilters({}), {}, entry), true);
  assert.equal(runningMatches(parseLogFilters({ status: "500" }), {}, entry), false);
  assert.equal(runningMatches(parseLogFilters({ pii: "1" }), {}, entry), false);
  assert.equal(runningMatches(parseLogFilters({ to: "2026-11-24" }), {}, entry), false);
  assert.equal(runningMatches(parseLogFilters({ model: "gpt-5" }), {}, entry), false);
  assert.equal(runningMatches(parseLogFilters({ endpoint: "messages" }), {}, entry), true);
  assert.equal(runningMatches(parseLogFilters({}), { orgId: "org-b" }, entry), false);
});

test("mergeLiveRows inserts only new rows, newest first, within the page size", () => {
  const current = [row("b", "2026-11-25T11:59:00.000Z"), row("a", "2026-11-25T11:58:00.000Z")];
  const same = mergeLiveRows(current, [row("b", "2026-11-25T11:59:00.000Z")], 50);
  assert.equal(same.added, 0);
  assert.equal(same.rows, current);
  const next = mergeLiveRows(
    current,
    [row("c", "2026-11-25T12:00:00.000Z"), row("c", "2026-11-25T12:00:00.000Z"), row("b", "2026-11-25T11:59:00.000Z")],
    2,
  );
  assert.equal(next.added, 1);
  assert.deepEqual(
    next.rows.map((item) => item.id),
    ["c", "b"],
  );
});

test("live log payload parsers drop malformed parts", () => {
  assert.equal(liveRowsOf({ rows: "nope" }), null);
  const rows = liveRowsOf({ rows: [row("a", "2026-11-25T12:00:00.000Z"), { id: 3 }], more: true });
  assert.deepEqual(
    rows?.rows.map((item) => item.id),
    ["a"],
  );
  assert.equal(rows?.more, true);
  const running = liveRunningOf({
    at: NOW,
    items: [{ id: "r1", startedAt: "2026-11-25T11:59:50.000Z", model: "m", endpoint: "/v1/chat/completions" }, { id: "r2" }],
  });
  assert.deepEqual(running?.items.map((item) => item.id), ["r1"]);
  assert.equal(running?.items[0]?.stream, false);
  assert.equal(liveRunningOf({ items: [] }), null);
  assert.deepEqual(liveKeyUsageOf({ at: NOW, usage: null }), { at: NOW, usage: null });
  assert.equal(liveKeyUsageOf({ at: NOW, usage: { keyId: "k", spend: "1" } })?.usage, null);
});

test("usageRatio counts boosts into the cap and has no ratio without a cap", () => {
  const usage: KeyBudgetUsage = {
    keyId: "k",
    label: "k",
    spend: 4,
    maxBudget: 5,
    boost: 0,
    budgetDuration: "",
    resetsAt: null,
  };
  assert.equal(usageRatio(usage), 0.8);
  assert.equal(usageRatio({ ...usage, boost: 3 }), 0.5);
  assert.equal(usageRatio({ ...usage, maxBudget: 0 }), null);
});

test("request activity tracks a running request until its log row is written", async () => {
  const { announceRequestLog, finishRequest, runningEntries, trackRequest, watchRequestActivity } = await import(
    "@/lib/gateway/request-logs/request-activity"
  );
  const seen: RequestActivity[] = [];
  const stop = watchRequestActivity((item) => seen.push(item));
  const trace = { endpoint: "/v1/messages" } as RequestTrace;
  const principal = {
    orgId: "org-a",
    userId: "user-a",
    key: { token_id: "key-a" },
    client: { session: "sess-1", agent: "claude_code" },
    trace,
  } as unknown as Principal;
  try {
    trackRequest(principal, { model: "claude-sonnet-5-5", stream: true }, NOW);
    trackRequest(principal, { model: "claude-sonnet-5-5", stream: true }, NOW);
    const running = runningEntries(NOW + 1_000).filter((entry) => entry.sessionId === "sess-1");
    assert.equal(running.length, 1);
    assert.equal(running[0]?.keyId, "key-a");
    assert.equal(running[0]?.stream, true);
    announceRequestLog({ orgId: "org-a", userId: "user-a", keyId: "key-a", sessionId: "sess-1" }, trace);
    finishRequest(trace);
    assert.equal(runningEntries(NOW + 2_000).filter((entry) => entry.sessionId === "sess-1").length, 0);
    assert.deepEqual(
      seen.filter((item) => item.sessionId === "sess-1").map((item) => item.kind),
      ["start", "row"],
    );
    const stale = { endpoint: "/v1/chat/completions" } as RequestTrace;
    trackRequest({ ...principal, client: { session: "sess-stale", agent: "" }, trace: stale }, { model: "m", stream: false }, NOW);
    assert.equal(runningEntries(NOW + 31 * 60_000).filter((entry) => entry.sessionId === "sess-stale").length, 0);
  } finally {
    stop();
  }
});

test("logStream sends running requests, new rows, and key budget for its filters only", async () => {
  const { liveAccess } = await import("@/lib/updates/live-stream");
  const { logStream } = await import("@/lib/gateway/request-logs/log-stream");
  const abort = new AbortController();
  const scope: SpendScope = { orgId: "org-a" };
  const filters = parseLogFilters({ keyId: "key-a", session: "sess-1" });
  const written: RequestLogRow[] = [row("old", "2026-11-25T11:59:58.000Z")];
  const afterCalls: number[] = [];
  let emit: (item: RequestActivity) => void = () => {};
  let spend = 1;
  const reader = logStream({
    sessionId: "session-logs-1",
    scope,
    filters,
    sinceMs: NOW,
    signal: abort.signal,
    pollMs: 60_000,
    heartbeatMs: 60_000,
    notifyMs: 0,
    checkAccess: async () => liveAccess(["spend:read"], scope),
    sources: {
      async loadRows(requested, requestedScope, afterMs) {
        assert.equal(requested.keyId, "key-a");
        assert.deepEqual(requestedScope, scope);
        afterCalls.push(afterMs);
        const rows = written.filter((item) => Date.parse(item.createdAt) > afterMs).reverse();
        return { rows, newestMs: rows[0] ? Date.parse(rows[0].createdAt) : null, full: false };
      },
      async loadKey(_scope, keyId) {
        return { keyId, label: "Agent key", spend, maxBudget: 5, boost: 0, budgetDuration: "30d", resetsAt: null };
      },
      running: () => [
        {
          id: "run-1",
          startedAt: "2026-11-25T11:59:59.000Z",
          startedMs: NOW - 1_000,
          model: "claude-sonnet-5-5",
          endpoint: "/v1/messages",
          stream: true,
          keyId: "key-a",
          agent: "claude_code",
          orgId: "org-a",
          userId: "user-a",
          sessionId: "sess-1",
        },
        {
          id: "run-other",
          startedAt: "2026-11-25T11:59:59.000Z",
          startedMs: NOW - 1_000,
          model: "claude-sonnet-5-5",
          endpoint: "/v1/messages",
          stream: true,
          keyId: "key-b",
          agent: "",
          orgId: "org-a",
          userId: "user-a",
          sessionId: "sess-1",
        },
      ],
      watch(listener) {
        emit = listener;
        return () => {
          emit = () => {};
        };
      },
    },
  }).getReader();
  try {
    const first = await readUntil(reader, (text) => text.includes("event: key"));
    assert.equal(afterCalls[0], NOW - 5_000);
    const [rowsEvent] = eventsOf(first, "rows") as { rows: RequestLogRow[] }[];
    assert.deepEqual(rowsEvent?.rows.map((item) => item.id), ["old"]);
    const [running] = eventsOf(first, "running") as { items: { id: string; orgId?: string }[] }[];
    assert.deepEqual(running?.items.map((item) => item.id), ["run-1"]);
    assert.equal(running?.items[0]?.orgId, undefined);
    const [key] = eventsOf(first, "key") as { usage: KeyBudgetUsage }[];
    assert.equal(key?.usage.spend, 1);

    emit(activity("row", { orgId: "org-b" }));
    emit(activity("row", { keyId: "key-b" }));
    written.push(row("new", "2026-11-25T12:00:01.000Z"));
    spend = 2;
    emit(activity("row"));
    const second = await readUntil(reader, (text) => text.includes("event: key"));
    const [fresh] = eventsOf(second, "rows") as { rows: RequestLogRow[] }[];
    assert.deepEqual(fresh?.rows.map((item) => item.id), ["new"]);
    assert.equal((eventsOf(second, "key")[0] as { usage: KeyBudgetUsage }).usage.spend, 2);
    assert.equal(eventsOf(second, "running").length, 0);
  } finally {
    abort.abort();
    await reader.cancel().catch(() => undefined);
  }
});

test("logStream ends with expired when the viewer loses spend access or changes scope", async () => {
  const { liveAccess } = await import("@/lib/updates/live-stream");
  const { logStream } = await import("@/lib/gateway/request-logs/log-stream");
  const abort = new AbortController();
  const reader = logStream({
    sessionId: "session-logs-2",
    scope: { orgId: "org-a" },
    filters: parseLogFilters({}),
    sinceMs: NOW,
    signal: abort.signal,
    pollMs: 60_000,
    heartbeatMs: 10,
    accessCheckMs: 0,
    checkAccess: async () => liveAccess(["spend:read"], { orgId: "org-b" }),
    sources: {
      loadRows: async () => ({ rows: [], newestMs: null, full: false }),
      loadKey: async () => null,
      running: () => [],
      watch: () => () => undefined,
    },
  }).getReader();
  try {
    const text = await readUntil(reader, (value) => value.includes("event: expired"));
    assert.match(text, /event: running/);
    assert.match(text, /event: expired/);
    assert.equal((await reader.read()).done, true);
  } finally {
    abort.abort();
  }
});
