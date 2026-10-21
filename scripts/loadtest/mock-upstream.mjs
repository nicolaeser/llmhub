import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { URLSearchParams } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "55438" },
    "ttfb-ms": { type: "string", default: "400" },
    "tokens-per-sec": { type: "string", default: "120" },
    "output-tokens": { type: "string", default: "160" },
    "thinking-tokens": { type: "string", default: "80" },
    "tool-use": { type: "string", default: "0.6" },
    jitter: { type: "string", default: "0.2" },
    "error-429": { type: "string", default: "0" },
    "error-529": { type: "string", default: "0" },
    "stream-error": { type: "string", default: "0" },
    disconnect: { type: "string", default: "0" },
  },
});

const config = {
  ttfbMs: Number(args["ttfb-ms"]),
  tokensPerSec: Number(args["tokens-per-sec"]),
  outputTokens: Number(args["output-tokens"]),
  thinkingTokens: Number(args["thinking-tokens"]),
  toolUse: Number(args["tool-use"]),
  jitter: Number(args.jitter),
  error429: Number(args["error-429"]),
  error529: Number(args["error-529"]),
  streamError: Number(args["stream-error"]),
  disconnect: Number(args.disconnect),
  resetSeconds: 0,
  unified429: true,
  accounts: {},
};

const initialConfig = JSON.stringify(config);
const CHUNK_TOKENS = 4;
const WORDS = "the gateway relays every event of this streamed answer while the session keeps its account".split(" ");
const MODELS = ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"];

let sequence = 0;
let timings = [];
const counters = { requests: 0, byPath: {}, byAccount: {}, byStatus: {}, injected: {} };
const sessions = new Map();
const promptCache = new Map();
const accountTokens = new Map();

function now() {
  return performance.timeOrigin + performance.now();
}

function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

function accountOf(req) {
  const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
  const token = bearer || String(req.headers["x-api-key"] ?? "");
  const label = /^loadtest-([a-z0-9]+)-/i.exec(token)?.[1];
  if (!token) return { label: "anonymous", oauth: false };
  return { label: label ?? "unknown", oauth: Boolean(bearer) && label !== "api" };
}

function settingsFor(account) {
  return { ...config, ...(config.accounts[account] ?? {}) };
}

function sessionOf(body) {
  const userId = body?.metadata?.user_id;
  if (typeof userId !== "string") return "";
  const suffix = /_session_([0-9a-f-]{8,})$/i.exec(userId)?.[1];
  if (suffix) return suffix;
  try {
    const parsed = JSON.parse(userId);
    return typeof parsed?.session_id === "string" ? parsed.session_id : "";
  } catch {
    return "";
  }
}

function varied(value, jitter) {
  return Math.max(0, Math.round(value * (1 + (Math.random() * 2 - 1) * jitter)));
}

function words(tokens) {
  const out = [];
  for (let i = 0; i < tokens; i++) out.push(WORDS[(i + sequence) % WORDS.length]);
  return out;
}

function chunks(tokens) {
  const list = words(tokens);
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK_TOKENS) out.push(`${list.slice(i, i + CHUNK_TOKENS).join(" ")} `);
  return out;
}

async function readBody(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  const raw = Buffer.concat(parts);
  if (!raw.length) return { raw, json: null };
  try {
    return { raw, json: JSON.parse(raw.toString("utf8")) };
  } catch {
    return { raw, json: null };
  }
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function unifiedHeaders(account, rejected, resetSeconds) {
  const used = Math.min(0.99, 0.1 + (accountTokens.get(account) ?? 0) / 2e7);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const fiveHourReset = rejected && resetSeconds ? nowSeconds + resetSeconds : nowSeconds + 3 * 3600;
  return {
    "anthropic-ratelimit-unified-status": rejected ? "rejected" : "allowed",
    "anthropic-ratelimit-unified-5h-status": rejected ? "rejected" : "allowed",
    "anthropic-ratelimit-unified-5h-utilization": rejected ? "1.0" : used.toFixed(4),
    "anthropic-ratelimit-unified-5h-reset": String(fiveHourReset),
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": (used / 3).toFixed(4),
    "anthropic-ratelimit-unified-7d-reset": String(nowSeconds + 4 * 86400),
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-reset": String(fiveHourReset),
    "anthropic-ratelimit-unified-fallback-percentage": "0.5",
    "anthropic-ratelimit-unified-overage-status": "rejected",
  };
}

function cacheUsage(account, session, inputTokens, cacheable) {
  const key = `${account}:${session || "none"}`;
  const previous = promptCache.get(key) ?? 0;
  const read = cacheable ? Math.min(previous, inputTokens) : 0;
  const created = cacheable ? Math.round((inputTokens - read) * 0.9) : 0;
  if (cacheable) promptCache.set(key, inputTokens);
  return { input_tokens: Math.max(1, inputTokens - read - created), cache_read_input_tokens: read, cache_creation_input_tokens: created };
}

function hasCacheControl(body) {
  return JSON.stringify(body ?? {}).includes('"cache_control"');
}

function toolName(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.find((tool) => typeof tool?.name === "string")?.name ?? "Bash";
}

function plan(body, settings) {
  const thinking = body?.thinking && body.thinking.type !== "disabled" ? varied(settings.thinkingTokens, settings.jitter) : 0;
  const text = Math.max(CHUNK_TOKENS, varied(settings.outputTokens, settings.jitter));
  const tool = Array.isArray(body?.tools) && body.tools.length > 0 && Math.random() < settings.toolUse;
  return { thinking, text, tool, name: toolName(body) };
}

function errorPayload(type, message) {
  return { type: "error", error: { type, message }, request_id: `req_mock_${randomBytes(6).toString("hex")}` };
}

function record(entry) {
  timings.push(entry);
  bump(counters.byStatus, String(entry.status));
}

function remember(session, account) {
  if (!session) return;
  const seen = sessions.get(session) ?? {};
  bump(seen, account);
  sessions.set(session, seen);
}

function injectedError(settings) {
  const roll = Math.random();
  if (roll < settings.error429) return 429;
  if (roll < settings.error429 + settings.error529) return 529;
  return 0;
}

function sendInjected(res, status, account, oauth, settings, entry) {
  bump(counters.injected, `${status}`);
  entry.status = status;
  entry.firstByteAt = now();
  entry.endAt = entry.firstByteAt;
  record(entry);
  if (status === 429) {
    const mode = settings.unified429 === true ? "rejected" : settings.unified429 || "none";
    const unified = oauth && mode !== "none" ? unifiedHeaders(account, mode === "rejected", settings.resetSeconds) : {};
    const headers = { "retry-after": String(settings.resetSeconds || 30), ...unified };
    json(res, 429, errorPayload("rate_limit_error", "This request would exceed your account's rate limit."), headers);
    return;
  }
  json(res, 529, errorPayload("overloaded_error", "Overloaded"));
}

function messageShell(id, model, usage) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { ...usage, output_tokens: 1 },
  };
}

function sse(res, event, payload) {
  return res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function paced(res, tokens, settings) {
  const gap = (CHUNK_TOKENS / Math.max(1, settings.tokensPerSec)) * 1000;
  await sleep(gap);
  return !res.destroyed && tokens > 0;
}

async function streamMessage(res, ctx) {
  const { id, model, usage, shape, settings, oauth, account, entry } = ctx;
  await sleep(varied(settings.ttfbMs, settings.jitter));
  if (res.destroyed) return "client_gone";
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "request-id": `req_mock_${id}`,
    ...(oauth ? unifiedHeaders(account, false, 0) : {}),
  });
  entry.firstByteAt = now();
  sse(res, "message_start", { type: "message_start", message: messageShell(id, model, usage) });
  sse(res, "ping", { type: "ping" });
  const disconnectAt = Math.random() < settings.disconnect ? 1 + Math.floor(Math.random() * 6) : -1;
  const errorAt = disconnectAt < 0 && Math.random() < settings.streamError ? 1 + Math.floor(Math.random() * 6) : -1;
  let sent = 0;
  let index = 0;
  const step = async () => {
    sent += 1;
    if (sent === disconnectAt) {
      bump(counters.injected, "disconnect");
      res.socket?.destroy();
      return false;
    }
    if (sent === errorAt) {
      bump(counters.injected, "stream_error");
      sse(res, "error", errorPayload("overloaded_error", "Overloaded"));
      res.end();
      return false;
    }
    return paced(res, 1, settings);
  };
  if (shape.thinking) {
    sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
    for (const part of chunks(shape.thinking)) {
      if (!(await step())) return "aborted";
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part } });
    }
    sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: randomBytes(96).toString("base64") } });
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }
  sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
  for (const part of chunks(shape.text)) {
    if (!(await step())) return "aborted";
    sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
  }
  sse(res, "content_block_stop", { type: "content_block_stop", index });
  index += 1;
  if (shape.tool) {
    const input = JSON.stringify({ command: `ls -la src/${sequence % 97}`, description: "List files" });
    sse(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: `toolu_mock_${randomBytes(8).toString("hex")}`, name: shape.name, input: {} },
    });
    for (let i = 0; i < input.length; i += 24) {
      if (!(await step())) return "aborted";
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: input.slice(i, i + 24) } });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
  }
  const output = shape.thinking + shape.text + (shape.tool ? 20 : 0);
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: shape.tool ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { ...usage, output_tokens: output },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
  accountTokens.set(account, (accountTokens.get(account) ?? 0) + output + usage.input_tokens + usage.cache_creation_input_tokens);
  return "ok";
}

async function plainMessage(res, ctx) {
  const { id, model, usage, shape, settings, oauth, account, entry } = ctx;
  const output = shape.thinking + shape.text + (shape.tool ? 20 : 0);
  await sleep(varied(settings.ttfbMs, settings.jitter) + (output / Math.max(1, settings.tokensPerSec)) * 1000);
  if (res.destroyed) return "client_gone";
  const content = [];
  if (shape.thinking) content.push({ type: "thinking", thinking: words(shape.thinking).join(" "), signature: randomBytes(96).toString("base64") });
  content.push({ type: "text", text: words(shape.text).join(" ") });
  if (shape.tool) {
    content.push({ type: "tool_use", id: `toolu_mock_${randomBytes(8).toString("hex")}`, name: shape.name, input: { command: "ls" } });
  }
  entry.firstByteAt = now();
  json(
    res,
    200,
    { ...messageShell(id, model, usage), content, stop_reason: shape.tool ? "tool_use" : "end_turn", usage: { ...usage, output_tokens: output } },
    oauth ? unifiedHeaders(account, false, 0) : {},
  );
  accountTokens.set(account, (accountTokens.get(account) ?? 0) + output + usage.input_tokens);
  return "ok";
}

async function messages(req, res, entry) {
  const { raw, json: body } = await readBody(req);
  const { label: account, oauth } = accountOf(req);
  const settings = settingsFor(account);
  const session = sessionOf(body);
  entry.account = account;
  entry.session = session;
  entry.bytes = raw.length;
  bump(counters.byAccount, account);
  remember(session, account);
  if (!body || typeof body.model !== "string") {
    entry.status = 400;
    entry.firstByteAt = entry.endAt = now();
    record(entry);
    json(res, 400, errorPayload("invalid_request_error", "model: Field required"));
    return;
  }
  const injected = injectedError(settings);
  if (injected) {
    sendInjected(res, injected, account, oauth, settings, entry);
    return;
  }
  sequence += 1;
  const id = `msg_mock_${sequence.toString(36)}_${randomBytes(4).toString("hex")}`;
  entry.id = id;
  const usage = cacheUsage(account, session, Math.ceil(raw.length / 4), hasCacheControl(body));
  entry.cacheRead = usage.cache_read_input_tokens;
  entry.cacheWrite = usage.cache_creation_input_tokens;
  const ctx = { id, model: body.model, usage, shape: plan(body, settings), settings, oauth, account, entry };
  entry.stream = body.stream === true;
  entry.outcome = body.stream === true ? await streamMessage(res, ctx) : await plainMessage(res, ctx);
  entry.status = 200;
  entry.endAt = now();
  record(entry);
}

async function countTokens(req, res, entry) {
  const { raw } = await readBody(req);
  const { label } = accountOf(req);
  entry.account = label;
  bump(counters.byAccount, `${label}:count`);
  await sleep(varied(Math.min(80, settingsFor(label).ttfbMs / 4), 0.2));
  entry.status = 200;
  entry.firstByteAt = entry.endAt = now();
  record(entry);
  json(res, 200, { input_tokens: Math.ceil(raw.length / 4) });
}

function accountFromToken(token) {
  return /^loadtest-([a-z0-9]+)-/i.exec(token ?? "")?.[1] ?? "unknown";
}

function accountUuid(label) {
  const hex = createHash("sha256").update(label).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function oauthToken(req, res) {
  const { raw, json: body } = await readBody(req);
  const params = body ?? Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
  const label = accountFromToken(params.refresh_token ?? params.code);
  bump(counters.byPath, "oauth_refresh");
  json(res, 200, {
    token_type: "Bearer",
    access_token: `loadtest-${label}-access-${randomBytes(12).toString("hex")}`,
    refresh_token: `loadtest-${label}-refresh-${randomBytes(12).toString("hex")}`,
    expires_in: 28800,
    scope: "user:inference user:profile",
    account: { uuid: accountUuid(label), email_address: `${label}@loadtest.invalid` },
    organization: { uuid: accountUuid(`${label}-org`), name: `${label} org` },
  });
}

function profile(req, res) {
  const { label } = accountOf(req);
  json(res, 200, {
    account: { uuid: accountUuid(label), email: `${label}@loadtest.invalid`, email_address: `${label}@loadtest.invalid`, has_claude_max: true, display_name: label },
    organization: { uuid: accountUuid(`${label}-org`), rate_limit_tier: "default_claude_max_20x", organization_type: "claude_max" },
  });
}

function usageWindows(req, res) {
  const { label } = accountOf(req);
  bump(counters.byPath, "oauth_usage");
  const used = Math.min(99, 10 + (accountTokens.get(label) ?? 0) / 2e5);
  const reset = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
  json(res, 200, {
    five_hour: { utilization: used, resets_at: reset(3) },
    seven_day: { utilization: used / 3, resets_at: reset(96) },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  });
}

function models(res) {
  json(res, 200, {
    data: MODELS.map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" })),
    has_more: false,
    first_id: MODELS[0],
    last_id: MODELS[MODELS.length - 1],
  });
}

function sessionSpread() {
  const spread = { sessions: sessions.size, sticky: 0, moved: 0, accountsPerSession: {} };
  for (const seen of sessions.values()) {
    const count = Object.keys(seen).length;
    bump(spread.accountsPerSession, String(count));
    if (count === 1) spread.sticky += 1;
    else spread.moved += 1;
  }
  return spread;
}

async function control(req, res) {
  const { json: body } = await readBody(req);
  if (body && typeof body === "object") {
    const { accounts, ...rest } = body;
    Object.assign(config, rest);
    if (accounts && typeof accounts === "object") {
      for (const [label, overrides] of Object.entries(accounts)) {
        config.accounts[label] = overrides === null ? undefined : { ...(config.accounts[label] ?? {}), ...overrides };
      }
    }
  }
  json(res, 200, config);
}

function reset(res) {
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, JSON.parse(initialConfig));
  timings = [];
  sessions.clear();
  promptCache.clear();
  counters.requests = 0;
  for (const key of ["byPath", "byAccount", "byStatus", "injected"]) counters[key] = {};
  json(res, 200, { ok: true });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const path = url.pathname;
  counters.requests += 1;
  bump(counters.byPath, `${req.method} ${path}`);
  const entry = { path, receivedAt: now(), status: 0 };
  try {
    if (req.method === "POST" && path === "/v1/messages") return await messages(req, res, entry);
    if (req.method === "POST" && path === "/v1/messages/count_tokens") return await countTokens(req, res, entry);
    if (req.method === "POST" && path === "/v1/oauth/token") return await oauthToken(req, res);
    if (req.method === "GET" && path === "/api/oauth/profile") return profile(req, res);
    if (req.method === "GET" && path === "/api/oauth/usage") return usageWindows(req, res);
    if (req.method === "GET" && path === "/api/organizations") return json(res, 200, []);
    if (req.method === "GET" && path === "/v1/models") return models(res);
    if (req.method === "POST" && path === "/__control") return await control(req, res);
    if (req.method === "POST" && path === "/__reset") return reset(res);
    if (req.method === "GET" && path === "/__stats") return json(res, 200, { ...counters, sessions: sessionSpread(), config });
    if (req.method === "GET" && path === "/__timings") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return json(res, 200, timings.filter((item) => item.receivedAt >= since));
    }
    json(res, 404, errorPayload("not_found_error", `no mock for ${req.method} ${path}`));
  } catch (err) {
    if (!res.headersSent) json(res, 500, errorPayload("api_error", err instanceof Error ? err.message : "mock failure"));
    else res.destroy();
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;
server.listen(Number(args.port), args.host, () => {
  console.log(JSON.stringify({ mock: `http://${args.host}:${args.port}`, config }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
