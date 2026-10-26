import { gatewayRequest, MODEL, resetGateway, setKeyOverride } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { beforeEach } from "node:test";
import { clientSessionKey, runSession } from "@/lib/gateway/routing/account-affinity";
import { agentName, requestClient } from "@/lib/gateway/request-logs/request-session";
import {
  accountSwitchFlags,
  countAccountSwitches,
  countPinnedAccounts,
  leadingAgent,
  sessionModels,
  sessionSpan,
  switchesPossible,
} from "@/lib/gateway/request-logs/session-stats";
import { parseSessionRef, parseSessionSort } from "@/lib/gateway/request-logs/sessions";
import { logFilterParams, parseLogFilters, requestLogWhere } from "@/lib/gateway/request-logs/request-log-query";
import { logsQuerySchema, sessionsQuerySchema } from "@/schemas/management";
import { readQuery } from "@/lib/management/http";
import { serializeRequestSession } from "@/lib/management/serialize";
import type { JsonMap } from "@/types/gateway";
import type { LogSessionRow } from "@/types/logs";

const CLAUDE_RUN = "0f8c7a1e-1b2d-4c3e-9f00-123456789abc";
const CODEX_RUN = "7d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

beforeEach(() => resetGateway());

function headers(values: Record<string, string> = {}): Headers {
  return new Headers(values);
}

test("an explicit x-llmhub-session header wins over every client identifier", () => {
  const client = requestClient(headers({ "x-llmhub-session": " refactor-auth ", session_id: CODEX_RUN }), {
    prompt_cache_key: "cache-key",
    metadata: { user_id: `user_abc_account_def_session_${CLAUDE_RUN}`, session_id: "meta" },
  });
  assert.equal(client.session, "refactor-auth");
});

test("client session identifiers follow the account stickiness order", () => {
  assert.equal(requestClient(headers(), { prompt_cache_key: "cache-key", metadata: { session_id: "meta" } }).session, "cache-key");
  assert.equal(
    requestClient(headers(), { metadata: { user_id: `user_abc_account_def_session_${CLAUDE_RUN}` } }).session,
    `claude-code-${CLAUDE_RUN}`,
  );
  assert.equal(
    requestClient(headers(), { metadata: { user_id: JSON.stringify({ device_id: "d", session_id: CLAUDE_RUN }) } }).session,
    `claude-code-${CLAUDE_RUN}`,
  );
  assert.equal(requestClient(headers({ "x-claude-code-session-id": CLAUDE_RUN })).session, `claude-code-${CLAUDE_RUN}`);
  assert.equal(requestClient(headers(), { metadata: { session_id: "meta" } }).session, "meta");
  assert.equal(requestClient(headers({ session_id: CODEX_RUN })).session, CODEX_RUN);
});

test("the log session equals the routing session whenever routing pins one", () => {
  const body: JsonMap = { metadata: { user_id: `user_abc_account_def_session_${CLAUDE_RUN}` } };
  const key = clientSessionKey(body);
  assert.equal(requestClient(headers(), body).session, key);
  assert.equal(runSession(body), createHash("sha256").update(key).digest("hex").slice(0, 32));
  assert.equal(runSession({ metadata: { user_id: "plain-user" } }), "");
});

test("requests without a session identifier stay unassigned", () => {
  assert.deepEqual(requestClient(headers({ "user-agent": "curl/8.0" }), { model: MODEL, user: "ada", tags: ["x"] }), {
    session: "",
    agent: "",
  });
  assert.equal(requestClient(headers(), { metadata: { user_id: "plain-user" } }).session, "");
  assert.equal(requestClient(headers({ "x-llmhub-session": "x".repeat(513) })).session, "");
  assert.equal(requestClient(headers(), { prompt_cache_key: "y".repeat(513) }).session, "");
});

test("the agent comes from x-llmhub-agent, else the Claude Code or Codex client identity", () => {
  assert.equal(requestClient(headers({ "x-llmhub-agent": "My Bot/2" })).agent, "my_bot_2");
  assert.equal(agentName("  --Cline--  "), "cline");
  assert.equal(agentName("Claude Code"), "claude_code");
  assert.equal(requestClient(headers({ "user-agent": "claude-cli/2.1.0 (external, cli)" })).agent, "claude_code");
  assert.equal(requestClient(headers({ "x-claude-code-session-id": CLAUDE_RUN })).agent, "claude_code");
  assert.equal(
    requestClient(headers(), { metadata: { user_id: `user_abc_account_def_session_${CLAUDE_RUN}` } }).agent,
    "claude_code",
  );
  assert.equal(requestClient(headers({ originator: "codex_cli_rs" })).agent, "codex");
  assert.equal(requestClient(headers({ "user-agent": "codex_exec/0.50.0 (Linux)" })).agent, "codex");
  assert.equal(requestClient(headers({ "x-llmhub-agent": "aider", originator: "codex_cli_rs" })).agent, "aider");
});

test("account switches count handovers within a pinned kind only", () => {
  const steps = [
    { provider: "claude", providerId: "acct-a" },
    { provider: "openai", providerId: "key-1" },
    { provider: "claude", providerId: "acct-a" },
    { provider: "openai", providerId: "key-2" },
    { provider: "claude", providerId: "acct-b" },
    { provider: "anthropic", providerId: "api-1" },
    { provider: "claude", providerId: "" },
    { provider: "claude", providerId: "acct-a" },
    { provider: "anthropic", providerId: "api-1" },
  ];
  assert.deepEqual(accountSwitchFlags(steps), [false, false, false, false, true, false, false, true, false]);
  assert.equal(countAccountSwitches(steps), 2);
  assert.equal(countPinnedAccounts(steps), 3);
  assert.equal(switchesPossible(steps), true);
  assert.equal(
    switchesPossible([
      { provider: "openai", providerId: "key-1" },
      { provider: "openai", providerId: "key-2" },
      { provider: "claude", providerId: "acct-a" },
      { provider: "codex", providerId: "acct-c" },
    ]),
    false,
  );
});

test("session totals pick the busiest agent, rank models, and start at the first request", () => {
  assert.equal(
    leadingAgent([
      { agent: "", requests: 50 },
      { agent: "codex", requests: 3 },
      { agent: "claude_code", requests: 3 },
    ]),
    "claude_code",
  );
  assert.deepEqual(
    sessionModels([
      { model: "haiku", requests: 4 },
      { model: "opus", requests: 9 },
      { model: "haiku", requests: 6 },
      { model: "", requests: 1 },
    ]),
    [
      { model: "haiku", requests: 10 },
      { model: "opus", requests: 9 },
    ],
  );
  const span = sessionSpan(new Date("2026-10-26T10:00:05Z"), 5_000, new Date("2026-10-26T10:30:00Z"));
  assert.equal(span.startedAt.toISOString(), "2026-10-26T10:00:00.000Z");
  assert.equal(span.durationMs, 30 * 60_000);
});

test("session refs need a session id and bounded key and user ids", () => {
  assert.deepEqual(parseSessionRef({ sessionId: "run-1", keyId: "key-1" }), { sessionId: "run-1", keyId: "key-1", userId: "" });
  assert.equal(parseSessionRef({ sessionId: "", keyId: "key-1" }), null);
  assert.equal(parseSessionRef({ sessionId: "run-1", keyId: 7 }), null);
  assert.equal(parseSessionRef({ sessionId: "s".repeat(513) }), null);
  assert.equal(parseSessionRef(null), null);
});

test("session sorting accepts recent, cost, and requests and falls back to the most recent first", () => {
  assert.deepEqual(parseSessionSort({ by: "cost", direction: "asc" }), { by: "cost", direction: "asc" });
  assert.deepEqual(parseSessionSort({ by: "requests" }), { by: "requests", direction: "desc" });
  assert.deepEqual(parseSessionSort({ by: "duration", direction: "asc" }), { by: "recent", direction: "desc" });
  assert.deepEqual(parseSessionSort(undefined), { by: "recent", direction: "desc" });
  const query = readQuery(new Request("http://hub.local/api/mgmt/logs/sessions?sort=cost&order=asc"), sessionsQuerySchema);
  assert.equal(query.sort, "cost");
  assert.equal(query.order, "asc");
  assert.equal(readQuery(new Request("http://hub.local/api/mgmt/logs/sessions"), sessionsQuerySchema).sort, "recent");
});

test("the session filter narrows request logs inside the viewer's scope", () => {
  const filters = parseLogFilters({ session: ` ${CLAUDE_RUN} `, keyId: "key-1" });
  assert.equal(filters.session, CLAUDE_RUN);
  assert.equal(logFilterParams(filters).session, CLAUDE_RUN);
  const where = requestLogWhere(filters, { orgId: "org-1" });
  assert.equal(where.sessionId, CLAUDE_RUN);
  assert.deepEqual(where.AND, [{ keyId: "key-1" }, { orgId: "org-1" }]);
  assert.equal(requestLogWhere(parseLogFilters({}), {}).sessionId, undefined);
});

test("label and session filters narrow request logs and sessions together", () => {
  const where = requestLogWhere(parseLogFilters({ label: "cost_center:4711", session: CODEX_RUN }), {});
  assert.equal(where.sessionId, CODEX_RUN);
  assert.deepEqual(where.labels, { has: "cost_center:4711" });
  const query = readQuery(
    new Request(`http://hub.local/api/mgmt/logs/sessions?label=cost_center:4711&session=${CODEX_RUN}&sort=cost`),
    sessionsQuerySchema,
  );
  assert.deepEqual(query.label, { key: "cost_center", value: "4711" });
  assert.equal(query.session, CODEX_RUN);
});

test("the management API accepts a session filter and serializes session totals", () => {
  const query = readQuery(new Request(`http://hub.local/api/mgmt/logs/sessions?session=${CODEX_RUN}&page_size=10`), logsQuerySchema);
  assert.equal(query.session, CODEX_RUN);
  const row: LogSessionRow = {
    sessionId: CODEX_RUN,
    keyId: "key-1",
    userId: "",
    keyLabel: "ci",
    userLabel: "",
    memberId: "",
    memberLabel: "",
    agent: "codex",
    active: false,
    startedAt: "2026-10-26T10:00:00.000Z",
    lastAt: "2026-10-26T10:30:00.000Z",
    durationMs: 1_800_000,
    requests: 312,
    errors: 3,
    promptTokens: 1000,
    completionTokens: 200,
    cacheReadTokens: 50,
    cacheWriteTokens: 5,
    cost: 4.2,
    models: [{ model: "gpt-5", requests: 312 }],
    accounts: 2,
    accountSwitches: 2,
  };
  const serialized = serializeRequestSession(row);
  assert.equal(serialized.object, "request_session");
  assert.equal(serialized.session_id, CODEX_RUN);
  assert.equal(serialized.user_id, null);
  assert.equal(serialized.account_switches, 2);
  assert.deepEqual(serialized.models, [{ model: "gpt-5", requests: 312 }]);
});

async function loggedRows(): Promise<JsonMap[]> {
  for (let wait = 0; wait < 400 && !recordedPrisma.called("requestLog", "create").length; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return recordedPrisma.called("requestLog", "create").map((call) => (call.args as { data: JsonMap }).data);
}

test("gateway routes log the session and agent of each request", async () => {
  const messages = await import("@/app/api/v1/messages/route");
  const res = await messages.POST(
    gatewayRequest(
      "/api/v1/messages",
      {
        model: MODEL,
        max_tokens: 16,
        metadata: { user_id: `user_abc_account_def_session_${CLAUDE_RUN}` },
        messages: [{ role: "user", content: "hi" }],
      },
      { "user-agent": "claude-cli/2.1.0 (external, cli)", "x-claude-code-session-id": CLAUDE_RUN },
    ),
  );
  assert.equal(res.status, 200, await res.clone().text());
  const [claude] = await loggedRows();
  assert.equal(claude?.sessionId, `claude-code-${CLAUDE_RUN}`);
  assert.equal(claude?.agent, "claude_code");
  assert.equal(claude?.providerId, "");

  recordedPrisma.reset();
  const responses = await import("@/app/api/v1/responses/route");
  const codex = await responses.POST(
    gatewayRequest(
      "/api/v1/responses",
      { model: MODEL, input: "hi", prompt_cache_key: CODEX_RUN },
      { originator: "codex_cli_rs", session_id: CODEX_RUN },
    ),
  );
  assert.equal(codex.status, 200, await codex.clone().text());
  const [codexRow] = await loggedRows();
  assert.equal(codexRow?.sessionId, CODEX_RUN);
  assert.equal(codexRow?.agent, "codex");

  recordedPrisma.reset();
  const chat = await import("@/app/api/v1/chat/completions/route");
  const plain = await chat.POST(gatewayRequest("/api/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(plain.status, 200, await plain.clone().text());
  const [plainRow] = await loggedRows();
  assert.equal(plainRow?.sessionId, "");
  assert.equal(plainRow?.agent, "");
});

test("logged session ids are masked with the effective PII policy like tags", async () => {
  setKeyOverride({
    pii: { enabled: true, mode: "mask", output: false, entities: ["EMAIL_ADDRESS"], detector: "patterns", failure: "patterns" },
  });
  const chat = await import("@/app/api/v1/chat/completions/route");
  const send = (session: string) =>
    chat.POST(
      gatewayRequest(
        "/api/v1/chat/completions",
        { model: MODEL, messages: [{ role: "user", content: "hi" }] },
        { "x-llmhub-session": session },
      ),
    );
  assert.equal((await send("run for ada@acme.com")).status, 200);
  const [masked] = await loggedRows();
  assert.equal(masked?.sessionId, "run for [EMAIL_ADDRESS]");

  recordedPrisma.reset();
  assert.equal((await send(`claude-code-${CLAUDE_RUN}`)).status, 200);
  const [kept] = await loggedRows();
  assert.equal(kept?.sessionId, `claude-code-${CLAUDE_RUN}`);
});
