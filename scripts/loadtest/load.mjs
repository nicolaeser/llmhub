import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { clearTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);

const { values: args } = parseArgs({
  options: {
    state: { type: "string", default: "loadtest-state.json" },
    model: { type: "string", default: "claude-load" },
    base: { type: "string", default: "http://127.0.0.1:3000" },
    mount: { type: "string", default: "subscription" },
    stages: { type: "string", default: "10:60,50:60,150:60" },
    mock: { type: "string", default: "" },
    metrics: { type: "string", default: "" },
    "pg-container": { type: "string", default: "" },
    "pg-database": { type: "string", default: "llmhub" },
    "think-ms": { type: "string", default: "300:1500" },
    "count-tokens": { type: "string", default: "0.08" },
    "warm-turns": { type: "string", default: "6" },
    "max-history-kb": { type: "string", default: "600" },
    "abort-rate": { type: "string", default: "0" },
    "early-abort-share": { type: "string", default: "0.3" },
    "client-timeout-ms": { type: "string", default: "330000" },
    control: { type: "string", multiple: true, default: [] },
    out: { type: "string", default: "" },
    label: { type: "string", default: "" },
  },
});

const MAX_SESSIONS = 300;
const MAX_SECONDS = 1200;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function loopback(raw, name) {
  const url = new URL(raw);
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error(`--${name} must point at a loopback address, got ${url.hostname}`);
  return url;
}

const state = JSON.parse(readFileSync(args.state, "utf8"));
if (state.model !== args.model) throw new Error(`--model ${args.model} does not match the seeded model alias in ${args.state}`);
const base = loopback(args.base, "base");
if (args.mock) loopback(args.mock, "mock");
const prefix = args.mount === "api" ? "/api/v1" : "/api/subscription/v1";
const agent = new Agent({ keepAlive: true, maxSockets: Infinity });
const [thinkMin, thinkMax] = args["think-ms"].split(":").map(Number);
const countRate = Number(args["count-tokens"]);
const abortRate = Number(args["abort-rate"]);
const earlyAbortShare = Number(args["early-abort-share"]);
const maxHistory = Number(args["max-history-kb"]) * 1024;
const stages = args.stages.split(",").map((item, index) => {
  const [sessions, seconds] = item.split(":").map(Number);
  if (!(Number.isInteger(sessions) && sessions > 0 && sessions <= MAX_SESSIONS)) throw new Error(`stage ${index}: sessions must be 1 to ${MAX_SESSIONS}`);
  if (!(seconds > 0)) throw new Error(`stage ${index}: seconds must be positive`);
  return { index, sessions, seconds };
});
if (stages.reduce((sum, stage) => sum + stage.seconds, 0) > MAX_SECONDS) throw new Error(`the stages may run at most ${MAX_SECONDS} s in total`);

const TOOL_NAMES = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite", "WebFetch", "Task", "NotebookEdit", "MultiEdit", "LS", "ExitPlanMode", "WebSearch", "BashOutput", "KillShell"];
const FILLER = "Follow the repository conventions, keep changes small, verify with the real checks, and report what changed. ";
const SYSTEM_PROMPT = FILLER.repeat(110);
const TOOLS = TOOL_NAMES.map((name, i) => ({
  name,
  description: `${name} tool. ${FILLER.repeat(8 + (i % 5))}`,
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command or path to operate on" },
      description: { type: "string", description: "Short description of the action" },
      timeout: { type: "number", description: "Optional timeout in milliseconds" },
    },
    required: ["command"],
    additionalProperties: false,
  },
}));
const BETAS = "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";

function now() {
  return performance.timeOrigin + performance.now();
}

function between(min, max) {
  return min + Math.random() * (max - min);
}

function fileText(seed) {
  const lines = [];
  const count = 40 + (seed % 60);
  for (let i = 0; i < count; i++) lines.push(`${String(i + 1).padStart(4)}  export const value${seed}_${i} = compute(${i}, "${randomBytes(6).toString("hex")}");`);
  return lines.join("\n");
}

function headersFor(session, body) {
  return {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    accept: "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETAS,
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": "claude-cli/2.1.280 (external, cli)",
    "x-app": "cli",
    "x-stainless-lang": "js",
    "x-stainless-package-version": "0.60.0",
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
    ...(session.bearer ? { authorization: `Bearer ${session.key}` } : { "x-api-key": session.key }),
  };
}

function newSession(index) {
  const key = state.keys[index % state.keys.length];
  const id = randomUUID();
  const userId =
    index % 2 === 0
      ? JSON.stringify({ device_id: randomBytes(32).toString("hex"), account_uuid: randomUUID(), session_id: id })
      : `user_${randomBytes(32).toString("hex")}_account_${randomUUID()}_session_${id}`;
  const session = { index, id, key: key.key, bearer: index % 3 === 0, userId, messages: [], turns: 0, stopped: false };
  session.messages.push({ role: "user", content: [{ type: "text", text: `Task ${index}: refactor module ${index % 17} and run the tests.` }] });
  return session;
}

function withBreakpoints(messages) {
  const copy = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => {
          if (!block.cache_control) return block;
          const rest = { ...block };
          delete rest.cache_control;
          return rest;
        })
      : message.content,
  }));
  const last = copy[copy.length - 1];
  if (last && Array.isArray(last.content) && last.content.length) {
    const blocks = [...last.content];
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
    copy[copy.length - 1] = { ...last, content: blocks };
  }
  return copy;
}

function messagesBody(session, stream) {
  return {
    model: args.model,
    max_tokens: 32000,
    stream,
    thinking: { type: "enabled", budget_tokens: 8000 },
    metadata: { user_id: session.userId },
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    tools: TOOLS,
    messages: withBreakpoints(session.messages),
  };
}

function countBody(session) {
  return { model: args.model, system: messagesBody(session, false).system, tools: TOOLS, messages: session.messages };
}

function parseBlock(block) {
  let event = "";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: data.join("\n") };
}

class StreamCheck {
  constructor(model) {
    this.model = model;
    this.state = "start";
    this.open = null;
    this.next = 0;
    this.blocks = [];
    this.problem = "";
    this.id = "";
    this.firstEventAt = 0;
    this.errorType = "";
  }

  fail(reason) {
    if (!this.problem) this.problem = reason;
  }

  push(event, raw) {
    if (!this.firstEventAt) this.firstEventAt = now();
    if (this.state === "stopped") return this.fail("event_after_stop");
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.fail("bad_json");
    }
    const type = event || json.type;
    if (type !== json.type) return this.fail("event_type_mismatch");
    if (type === "ping") return undefined;
    if (type === "error") {
      this.errorType = json.error?.type ?? "error";
      this.state = "errored";
      return this.fail(`stream_error:${this.errorType}`);
    }
    if (this.state === "start") {
      if (type !== "message_start") return this.fail("missing_message_start");
      if (json.message?.model !== this.model) this.fail("model_not_rewritten");
      this.id = json.message?.id ?? "";
      this.state = "body";
      return undefined;
    }
    if (type === "content_block_start") {
      if (this.state !== "body" || this.open) return this.fail("block_start_out_of_order");
      if (json.index !== this.next) return this.fail("block_index_gap");
      this.open = { ...json.content_block, partial: "" };
      if (this.open.type === "thinking") this.open.thinking = "";
      if (this.open.type === "text") this.open.text = "";
      return undefined;
    }
    if (type === "content_block_delta") {
      if (!this.open || json.index !== this.next) return this.fail("delta_without_block");
      const delta = json.delta ?? {};
      if (delta.type === "text_delta" && this.open.type === "text") this.open.text += delta.text;
      else if (delta.type === "thinking_delta" && this.open.type === "thinking") this.open.thinking += delta.thinking;
      else if (delta.type === "signature_delta" && this.open.type === "thinking") this.open.signature = delta.signature;
      else if (delta.type === "input_json_delta" && this.open.type === "tool_use") this.open.partial += delta.partial_json;
      else return this.fail("delta_type_mismatch");
      return undefined;
    }
    if (type === "content_block_stop") {
      if (!this.open || json.index !== this.next) return this.fail("stop_without_block");
      const { partial, ...block } = this.open;
      if (block.type === "tool_use") {
        try {
          block.input = partial ? JSON.parse(partial) : {};
        } catch {
          return this.fail("tool_input_corrupt");
        }
      }
      this.blocks.push(block);
      this.open = null;
      this.next += 1;
      return undefined;
    }
    if (type === "message_delta") {
      if (this.open) return this.fail("delta_before_block_stop");
      this.state = "delta";
      return undefined;
    }
    if (type === "message_stop") {
      if (this.state !== "delta") return this.fail("stop_before_delta");
      this.state = "stopped";
      return undefined;
    }
    return this.fail(`unknown_event:${type}`);
  }

  finish() {
    if (this.state !== "stopped" && !this.problem) this.fail("truncated");
    return this.problem;
  }
}

function send(path, body, session, onData, abortMs = 0) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const sentAt = now();
    const result = { path, sentAt, status: 0, headersAt: 0, endAt: 0, bytes: 0, reqBytes: payload.length, error: "", text: "" };
    const req = httpRequest(
      { protocol: base.protocol, hostname: base.hostname, port: base.port, path: `${prefix}${path}`, method: "POST", agent, headers: headersFor(session, payload) },
      (res) => {
        result.status = res.statusCode ?? 0;
        result.headersAt = now();
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          result.bytes += chunk.length;
          if (onData && result.status === 200) {
            if (onData(chunk, req) === false) req.destroy();
          } else result.text += chunk;
        });
        res.on("end", () => {
          result.endAt = now();
          resolve(result);
        });
        res.on("error", (err) => {
          result.endAt = now();
          result.error ||= err.code ?? err.message;
          resolve(result);
        });
        res.on("aborted", () => {
          result.error ||= "aborted";
        });
      },
    );
    req.setTimeout(Number(args["client-timeout-ms"]), () => req.destroy(new Error("client_timeout")));
    if (abortMs > 0) {
      const timer = setTimeout(() => {
        if (!result.headersAt) req.destroy(new Error("client_abort"));
      }, abortMs);
      req.on("close", () => clearTimeout(timer));
    }
    req.on("error", (err) => {
      result.endAt = now();
      result.error ||= err.code ?? err.message;
      resolve(result);
    });
    req.end(payload);
  });
}

function errorTypeOf(result) {
  if (result.error && !result.status) return `network:${result.error}`;
  try {
    const parsed = JSON.parse(result.text);
    return `${result.status}:${parsed?.error?.type ?? "unknown"}`;
  } catch {
    return `${result.status}:unparsed`;
  }
}

async function streamTurn(session, stageIndex, records) {
  const check = new StreamCheck(args.model);
  let buffer = "";
  const aborting = Math.random() < abortRate;
  const early = aborting && Math.random() < earlyAbortShare;
  const abortAfter = aborting && !early ? 2 + Math.floor(Math.random() * 20) : -1;
  const abortMs = early ? between(60, 240) : 0;
  let events = 0;
  const result = await send("/messages", messagesBody(session, true), session, (chunk) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      if (!block.trim() || block.startsWith(":")) continue;
      const { event, data } = parseBlock(block);
      if (!data) continue;
      check.push(event, data);
      events += 1;
      if (events === abortAfter) return false;
    }
    return true;
  }, abortMs);
  const abortedEarly = early && result.error === "client_abort";
  const aborted = abortedEarly || (abortAfter > 0 && events >= abortAfter);
  const record = { kind: "messages", stage: stageIndex, session: session.id, status: result.status, sentAt: result.sentAt, headersAt: result.headersAt, firstEventAt: check.firstEventAt, endAt: result.endAt, reqBytes: result.reqBytes, bytes: result.bytes, id: check.id, aborted, abortPhase: aborted ? (abortedEarly ? "before_headers" : "mid_stream") : "" };
  if (abortedEarly) {
    record.problem = "client_abort_before_headers";
    records.push(record);
    return null;
  }
  if (result.status !== 200) {
    record.error = errorTypeOf(result);
    records.push(record);
    return null;
  }
  if (aborted) {
    record.problem = "client_abort_mid_stream";
    records.push(record);
    return null;
  }
  const problem = check.finish() || (result.error ? `network:${result.error}` : "");
  if (problem) record.problem = problem;
  records.push(record);
  return problem ? null : check.blocks;
}

async function countTurn(session, stageIndex, records) {
  const result = await send("/messages/count_tokens", countBody(session), session, null);
  const record = { kind: "count", stage: stageIndex, session: session.id, status: result.status, sentAt: result.sentAt, headersAt: result.headersAt, firstEventAt: result.headersAt, endAt: result.endAt, reqBytes: result.reqBytes, bytes: result.bytes };
  if (result.status !== 200) record.error = errorTypeOf(result);
  else {
    try {
      if (!(JSON.parse(result.text).input_tokens > 0)) record.problem = "bad_count";
    } catch {
      record.problem = "bad_count";
    }
  }
  records.push(record);
}

function grow(session, blocks) {
  session.turns += 1;
  if (!blocks) {
    session.messages.push({ role: "assistant", content: [{ type: "text", text: "Retrying after the previous error." }] });
    session.messages.push({ role: "user", content: [{ type: "text", text: "Continue." }] });
    return;
  }
  const content = blocks.map((block) => {
    if (block.type === "thinking") return { type: "thinking", thinking: block.thinking, signature: block.signature ?? "" };
    if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    return { type: "text", text: block.text ?? "" };
  });
  session.messages.push({ role: "assistant", content });
  const calls = content.filter((block) => block.type === "tool_use");
  session.messages.push({
    role: "user",
    content: calls.length
      ? calls.map((call) => ({ type: "tool_result", tool_use_id: call.id, content: fileText(session.turns + session.index) }))
      : [{ type: "text", text: `Next step ${session.turns}: keep going with the refactor.` }],
  });
  if (JSON.stringify(session.messages).length > maxHistory) {
    session.messages = [{ role: "user", content: [{ type: "text", text: `Summary of the earlier conversation for session ${session.index}. ${FILLER.repeat(20)}` }] }];
  }
}

function warm(session, turns) {
  for (let i = 0; i < turns; i++) {
    grow(session, [
      { type: "thinking", thinking: FILLER.repeat(2), signature: randomBytes(96).toString("base64") },
      { type: "text", text: FILLER.repeat(3) },
      { type: "tool_use", id: `toolu_warm_${randomBytes(8).toString("hex")}`, name: "Read", input: { command: `src/file${i}.ts` } },
    ]);
  }
}

async function sessionLoop(session, clock, records) {
  while (!session.stopped) {
    const stage = clock.stage;
    if (Math.random() < countRate) await countTurn(session, stage, records);
    if (session.stopped) break;
    grow(session, await streamTurn(session, stage, records));
    await sleep(between(thinkMin, thinkMax));
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
}

function spread(values) {
  return { p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), max: percentile(values, 100) };
}

function tally(items, key) {
  const out = {};
  for (const item of items) out[item[key]] = (out[item[key]] ?? 0) + 1;
  return out;
}

async function getJson(url) {
  try {
    const res = await globalThis.fetch(url);
    return await res.json();
  } catch {
    return null;
  }
}

async function postJson(url, payload) {
  try {
    const res = await globalThis.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return await res.json();
  } catch {
    return null;
  }
}

async function psql(sql) {
  if (!args["pg-container"]) return "";
  try {
    const { stdout } = await run("docker", ["exec", args["pg-container"], "psql", "-U", "llmhub", "-d", args["pg-database"], "-At", "-F", "\t", "-c", sql], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

async function sampleConnections(samples) {
  const out = await psql(`select coalesce(state,'none'), count(*) from pg_stat_activity where datname = '${args["pg-database"]}' group by 1`);
  const row = { at: Date.now(), total: 0 };
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const [name, count] = line.split("\t");
    row[name] = Number(count);
    row.total += Number(count);
  }
  samples.push(row);
}

async function statementStats() {
  const out = await psql(
    `select calls, round(total_exec_time::numeric, 1), rows, regexp_replace(left(query, 160), '\\s+', ' ', 'g') from pg_stat_statements where dbid = (select oid from pg_database where datname = '${args["pg-database"]}') and query not ilike '%pg_stat%' order by calls desc limit 60`,
  );
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [calls, totalMs, rows, query] = line.split("\t");
      return { calls: Number(calls), totalMs: Number(totalMs), rows: Number(rows), query };
    });
}

function serverMetrics(from, to, requests) {
  if (!args.metrics) return null;
  let lines;
  try {
    lines = readFileSync(args.metrics, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((line) => line.at >= from && line.at <= to);
  } catch {
    return null;
  }
  if (!lines.length) return null;
  const mb = (value) => Math.round(value / 1048576);
  return {
    rssMaxMb: mb(Math.max(...lines.map((line) => line.rss))),
    rssEndMb: mb(lines[lines.length - 1].rss),
    heapUsedMaxMb: mb(Math.max(...lines.map((line) => line.heapUsed))),
    loopDelayP99Ms: percentile(lines.map((line) => line.loopDelayP99), 50),
    loopDelayMaxMs: Math.round(Math.max(...lines.map((line) => line.loopDelayMax))),
    loopUtilization: Math.round((lines.reduce((sum, line) => sum + line.loopUtilization, 0) / lines.length) * 100) / 100,
    cpuMsPerRequest: requests ? Math.round((lines.reduce((sum, line) => sum + (line.cpuMs ?? 0), 0) / requests) * 10) / 10 : null,
    poolWaitMsPerRequest: requests ? Math.round((lines.reduce((sum, line) => sum + (line.pool?.waitMs ?? 0), 0) / requests) * 10) / 10 : null,
    poolAcquisitionsPerRequest: requests ? Math.round((lines.reduce((sum, line) => sum + (line.pool?.acquisitions ?? 0), 0) / requests) * 10) / 10 : null,
    poolWaitMaxMs: Math.round(Math.max(0, ...lines.map((line) => line.pool?.waitMaxMs ?? 0))),
    poolWaitingMax: Math.max(0, ...lines.map((line) => line.pool?.waitingMax ?? 0)),
    poolTotalMax: Math.max(0, ...lines.map((line) => line.pool?.totalMax ?? 0)),
  };
}

function failedUpstream(item) {
  return item.status !== 200 || Boolean(item.injected);
}

function answered(item) {
  return Boolean(item.firstByteAt);
}

const PIN_HOLD_WINDOW_MS = 65_000;
const PIN_MOVE_STREAK = 3;

function accountSwitches(timings, sessionIds, from) {
  const messages = timings.filter((entry) => entry.path === "/v1/messages" && answered(entry)).sort((a, b) => a.receivedAt - b.receivedAt);
  const failures = new Map();
  for (const item of messages) {
    if (!failedUpstream(item)) continue;
    const list = failures.get(item.account) ?? [];
    list.push(item.receivedAt);
    failures.set(item.account, list);
  }
  const failedWithin = (account, at) => (failures.get(account) ?? []).some((time) => time <= at && time >= at - PIN_HOLD_WINDOW_MS);
  const bySession = new Map();
  for (const item of messages) {
    if (!item.session || !sessionIds.has(item.session)) continue;
    const list = bySession.get(item.session) ?? [];
    list.push(item);
    bySession.set(item.session, list);
  }
  const totals = { sessions: 0, sessionsOffHome: 0, offHomeTurns: 0, offHomeAfterFailure: 0, offHomeUnexplained: 0, pinMoves: 0, unexplainedPinMoves: 0 };
  const examples = [];
  for (const list of bySession.values()) {
    if (list.some((item) => item.receivedAt >= from)) totals.sessions += 1;
    let home = "";
    let streak = { account: "", count: 0, explained: true };
    let off = 0;
    let unexplained = 0;
    let sessionFailedAt = -Infinity;
    for (const item of list) {
      const counted = item.receivedAt >= from;
      if (failedUpstream(item)) {
        sessionFailedAt = item.receivedAt;
        continue;
      }
      if (!home) home = item.account;
      if (item.account === home) {
        streak = { account: "", count: 0, explained: true };
        continue;
      }
      const explained = failedWithin(home, item.receivedAt) || item.receivedAt - sessionFailedAt <= PIN_HOLD_WINDOW_MS;
      if (counted) {
        off += 1;
        if (explained) totals.offHomeAfterFailure += 1;
        else unexplained += 1;
      }
      streak = streak.account === item.account ? { ...streak, count: streak.count + 1 } : { account: item.account, count: 1, explained };
      if (streak.count >= PIN_MOVE_STREAK) {
        if (counted) {
          totals.pinMoves += 1;
          if (!streak.explained) totals.unexplainedPinMoves += 1;
        }
        home = item.account;
        streak = { account: "", count: 0, explained: true };
      }
    }
    totals.offHomeTurns += off;
    totals.offHomeUnexplained += unexplained;
    if (off) totals.sessionsOffHome += 1;
    if (unexplained && examples.length < 5) {
      examples.push(list.filter((item) => item.receivedAt >= from - PIN_HOLD_WINDOW_MS).map((item) => [Math.round(item.receivedAt), item.account, item.status, item.injected ?? item.outcome ?? ""].join(":")));
    }
  }
  return { ...totals, unexplainedExamples: examples };
}

const TIMELINE_LIMIT = 300;

function failureTimeline(records, timings, from) {
  const upstream = timings
    .filter((item) => item.path === "/v1/messages" && failedUpstream(item))
    .map((item) => ({ at: Math.round(item.receivedAt - from), source: "upstream", account: item.account, what: item.injected ?? String(item.status) }));
  const client = records
    .filter((record) => record.error)
    .map((record) => ({ at: Math.round(record.sentAt - from), source: "client", what: record.error }));
  return [...upstream, ...client].sort((a, b) => a.at - b.at).slice(0, TIMELINE_LIMIT);
}

function upstreamOutcomes(timings) {
  const messages = timings.filter((item) => item.path === "/v1/messages");
  return {
    byStatus: tally(messages, "status"),
    injected: tally(messages.filter((item) => item.injected), "injected"),
    outcomes: tally(messages.filter((item) => item.outcome), "outcome"),
    long: messages.filter((item) => item.long).length,
  };
}

async function bookings(since) {
  const out = await psql(
    `select status, outcome, stream, count(*) from "RequestLog" where "createdAt" >= '${new Date(since).toISOString()}' group by 1, 2, 3 order by 4 desc`,
  );
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, outcome, stream, count] = line.split("\t");
      return { status: Number(status), outcome, stream: stream === "t", count: Number(count) };
    });
}

function summarize(stage, records, timings, extra, from) {
  const messages = records.filter((record) => record.kind === "messages");
  const ok = messages.filter((record) => record.status === 200 && !record.problem);
  const counts = records.filter((record) => record.kind === "count");
  const byId = new Map(timings.filter((item) => item.id).map((item) => [item.id, item]));
  const pre = [];
  const firstByte = [];
  const tail = [];
  for (const record of ok) {
    const mock = byId.get(record.id);
    if (!mock) continue;
    pre.push(mock.receivedAt - record.sentAt);
    firstByte.push(record.firstEventAt - mock.firstByteAt);
    tail.push(record.endAt - mock.endAt);
  }
  const upstream = timings.filter((item) => item.path === "/v1/messages" && item.status === 200);
  const cacheRead = upstream.reduce((sum, item) => sum + (item.cacheRead ?? 0), 0);
  const cacheWrite = upstream.reduce((sum, item) => sum + (item.cacheWrite ?? 0), 0);
  const seconds = stage.seconds;
  return {
    stage: stage.index,
    sessions: stage.sessions,
    seconds,
    requests: records.length,
    messages: messages.length,
    throughputRps: Math.round((records.length / seconds) * 10) / 10,
    okMessages: ok.length,
    errors: tally(records.filter((record) => record.error), "error"),
    problems: tally(records.filter((record) => record.problem), "problem"),
    countTokens: { requests: counts.length, failed: counts.filter((record) => record.status !== 200 || record.problem).length, totalMs: spread(counts.map((record) => record.endAt - record.sentAt)) },
    requestKb: spread(messages.map((record) => record.reqBytes / 1024)),
    ttfbMs: spread(ok.map((record) => record.firstEventAt - record.sentAt)),
    headersMs: spread(ok.map((record) => record.headersAt - record.sentAt)),
    totalMs: spread(ok.map((record) => record.endAt - record.sentAt)),
    overheadMs: { beforeUpstream: spread(pre), firstByte: spread(firstByte), afterUpstreamEnd: spread(tail) },
    aborts: tally(messages.filter((record) => record.aborted), "abortPhase"),
    failures: failureTimeline(records, timings, from),
    upstream: { messages: upstream.length, byAccount: tally(upstream, "account"), ...upstreamOutcomes(timings), cacheReadShare: cacheRead + cacheWrite ? Math.round((cacheRead / (cacheRead + cacheWrite)) * 1000) / 1000 : null },
    ...extra,
  };
}

function printStage(summary) {
  const row = [
    `stage ${summary.stage}`,
    `sessions=${summary.sessions}`,
    `rps=${summary.throughputRps}`,
    `ok=${summary.okMessages}/${summary.messages}`,
    `ttfb p50/p95/p99=${summary.ttfbMs.p50}/${summary.ttfbMs.p95}/${summary.ttfbMs.p99}`,
    `total p50/p95/p99=${summary.totalMs.p50}/${summary.totalMs.p95}/${summary.totalMs.p99}`,
    `pre p50/p99=${summary.overheadMs.beforeUpstream.p50}/${summary.overheadMs.beforeUpstream.p99}`,
    `tail p50/p99=${summary.overheadMs.afterUpstreamEnd.p50}/${summary.overheadMs.afterUpstreamEnd.p99}`,
    `errors=${JSON.stringify(summary.errors)}`,
    `problems=${JSON.stringify(summary.problems)}`,
    `offhome=${summary.stickiness.offHomeTurns} (after failure ${summary.stickiness.offHomeAfterFailure}, unexplained ${summary.stickiness.offHomeUnexplained}) pinmoves=${summary.stickiness.pinMoves}`,
    summary.server ? `cpu/req=${summary.server.cpuMsPerRequest}ms poolwait/req=${summary.server.poolWaitMsPerRequest}ms elu=${summary.server.loopUtilization}` : "",
  ].filter(Boolean);
  console.log(row.join(" "));
}

function scheduleControls(started) {
  for (const entry of args.control) {
    const split = entry.indexOf(":");
    const at = Number(entry.slice(0, split));
    const payload = JSON.parse(entry.slice(split + 1));
    setTimeout(() => {
      void postJson(new URL("/__control", args.mock), payload).then(() => console.log(`control at ${at}s: ${JSON.stringify(payload)}`));
    }, Math.max(0, started + at * 1000 - Date.now()));
  }
}

async function main() {
  if (args.mock) await postJson(new URL("/__reset", args.mock), {});
  const records = [];
  const sessions = [];
  const clock = { stage: 0 };
  const loops = [];
  const summaries = [];
  const started = Date.now();
  const runTimingStart = now();
  scheduleControls(started);
  for (const stage of stages) {
    clock.stage = stage.index;
    await psql("select pg_stat_statements_reset()");
    const stageStart = Date.now();
    const timingStart = now();
    while (sessions.length < stage.sessions) {
      const session = newSession(sessions.length);
      warm(session, Number(args["warm-turns"]));
      sessions.push(session);
      loops.push(sessionLoop(session, clock, records));
    }
    const samples = [];
    const deadline = stageStart + stage.seconds * 1000;
    while (Date.now() < deadline) {
      await sampleConnections(samples);
      await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
    }
    const stageRecords = records.filter((record) => record.stage === stage.index);
    const statements = await statementStats();
    const runTimings = args.mock ? ((await getJson(`${new URL("/__timings", args.mock)}?since=${runTimingStart}`)) ?? []) : [];
    const timings = runTimings.filter((item) => item.receivedAt >= timingStart);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const calls = statements.reduce((sum, item) => sum + item.calls, 0);
    const writes = statements.filter((item) => /^\s*(insert|update|delete)/i.test(item.query)).reduce((sum, item) => sum + item.calls, 0);
    const summary = summarize(stage, stageRecords, timings, {
      stickiness: accountSwitches(runTimings, sessionIds, timingStart),
      server: serverMetrics(stageStart, Date.now(), stageRecords.length),
      postgres: args["pg-container"]
        ? {
            connectionsMax: Math.max(0, ...samples.map((row) => row.total)),
            activeMax: Math.max(0, ...samples.map((row) => row.active ?? 0)),
            idleInTransactionMax: Math.max(0, ...samples.map((row) => row["idle in transaction"] ?? 0)),
            statementsPerRequest: stageRecords.length ? Math.round((calls / stageRecords.length) * 10) / 10 : null,
            writesPerRequest: stageRecords.length ? Math.round((writes / stageRecords.length) * 10) / 10 : null,
            topByCalls: statements.slice(0, 12),
            topByTime: [...statements].sort((a, b) => b.totalMs - a.totalMs).slice(0, 8),
          }
        : null,
    }, timingStart);
    summaries.push(summary);
    printStage(summary);
  }
  for (const session of sessions) session.stopped = true;
  await Promise.race([Promise.all(loops), sleep(60_000)]);
  agent.destroy();
  await sleep(2000);
  const aborted = records.filter((record) => record.kind === "messages" && record.aborted);
  const booked = await bookings(started);
  const cancelled = booked.filter((row) => row.outcome === "cancelled").reduce((sum, row) => sum + row.count, 0);
  const totals = {
    requests: records.length,
    clientAborts: tally(aborted, "abortPhase"),
    bookedCancelled: cancelled,
    bookings: booked,
  };
  if (args["pg-container"]) console.log(`aborts=${JSON.stringify(totals.clientAborts)} booked cancelled=${cancelled} bookings=${JSON.stringify(booked)}`);
  const report = { label: args.label, mount: args.mount, base: args.base, stages: summaries, totals, startedAt: new Date(started).toISOString() };
  if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

void main();
