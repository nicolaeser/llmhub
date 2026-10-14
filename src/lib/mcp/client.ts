import { setTimeout as delay } from "node:timers/promises";
import { McpError } from "@/lib/mcp/errors";
import { bearerChallenge, headerParams, headerValue, paramHeaders } from "@/lib/mcp/headers";
import { readLimitedText, sseEvents } from "@/lib/mcp/sse";
import { SseChannel } from "@/lib/mcp/sse-channel";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cancelQuietly } from "@/lib/utils/streams";
import type { JsonMap } from "@/types/gateway";
import type { JsonRpcMessage, McpAuth, McpConnection, McpEra, McpFetch, McpToolOutcome, McpToolSpec } from "@/types/mcp";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const MCP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MCP_MAX_TOOLS = 200;
export const MCP_MAX_TOOL_RESULT_CHARS = 16_000;

const MAX_PAGES = 20;
const MAX_TOOL_NAME = 128;
const MAX_DESCRIPTION = 2_000;
const MAX_SCHEMA_BYTES = 32_000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_RESUMES = 5;
const DEFAULT_RETRY_MS = 1_000;
const MAX_RETRY_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;
const CLIENT_INFO = { name: "llmhub", version: "1.0.0" };
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const HEADER_MISMATCH = -32020;
const MISSING_CAPABILITY = -32021;
const UNSUPPORTED_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;
const MODERN_ERRORS = new Set([HEADER_MISMATCH, MISSING_CAPABILITY, UNSUPPORTED_VERSION]);
const FALLBACK_STATUS = new Set([400, 404, 405]);
const NAMED_PARAMS: Record<string, string> = { "tools/call": "name", "prompts/get": "name", "resources/read": "uri" };
const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

const NO_AUTH: McpAuth = { headers: async () => ({}), rejected: async () => false };

type ClientOptions = {
  url: string;
  fetch: McpFetch;
  auth?: McpAuth;
  connection?: McpConnection | null;
  capabilities?: JsonMap;
  timeoutMs?: number;
  maxBytes?: number;
};

class EraSwitch extends Error {
  constructor(
    readonly era: McpEra,
    readonly reason: McpError,
    readonly version = "",
  ) {
    super("MCP_ERA_SWITCH");
  }
}

export function staticAuth(headers: Record<string, string>): McpAuth {
  return { headers: async () => headers, rejected: async () => false };
}

export function isModernVersion(version: string): boolean {
  return version >= MCP_PROTOCOL_VERSION;
}

export function eraOf(connection: McpConnection | null | undefined): McpEra | null {
  if (connection?.transport === "sse") return "sse";
  if (!connection?.protocolVersion) return null;
  return isModernVersion(connection.protocolVersion) ? "modern" : "legacy";
}

function asMap(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : null;
}

function parseMessages(text: string): JsonRpcMessage[] {
  const parsed = parseJsonOrNull(text);
  if (parsed === null) throw new McpError("MCP_PROTOCOL_ERROR", "invalid JSON");
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.flatMap((item) => (asMap(item) ? [item as JsonRpcMessage] : []));
}

function isAnswer(message: JsonRpcMessage, id: number): boolean {
  return message.id === id && message.method === undefined && (message.result !== undefined || Boolean(message.error));
}

function rpcCode(message: JsonRpcMessage | null): number | null {
  return typeof message?.error?.code === "number" ? message.error.code : null;
}

function rpcDetail(message: JsonRpcMessage | null): string {
  return typeof message?.error?.message === "string" ? message.error.message.slice(0, 300) : "";
}

function rpcError(message: JsonRpcMessage): McpError {
  return new McpError("MCP_RPC_ERROR", rpcDetail(message), { rpcCode: rpcCode(message) });
}

function complete(result: unknown): JsonMap {
  const map = asMap(result) ?? {};
  if (map.resultType === undefined || map.resultType === "complete") return map;
  if (map.resultType === "input_required") throw new McpError("MCP_INPUT_REQUIRED");
  throw new McpError("MCP_PROTOCOL_ERROR", "unknown resultType");
}

function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function nameOf(info: JsonMap | null): string {
  return typeof info?.name === "string" ? clip(info.name, 200) : "";
}

function legacyReply(message: JsonRpcMessage): JsonMap | null {
  if (message.id === undefined || message.id === null || typeof message.method !== "string") return null;
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  return { jsonrpc: "2.0", id: message.id, error: { code: METHOD_NOT_FOUND, message: "Method not supported by this client" } };
}

export function toolSpecs(raw: unknown, onReject?: (name: string, reason: string) => void): McpToolSpec[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: McpToolSpec[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const tool = asMap(item);
    const name = typeof tool?.name === "string" ? tool.name.trim() : "";
    if (!tool || !name || name.length > MAX_TOOL_NAME || seen.has(name)) continue;
    const schema = asMap(tool.inputSchema) ?? { type: "object", properties: {} };
    if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) {
      onReject?.(name, "schema_too_large");
      continue;
    }
    if (!headerParams(schema)) {
      onReject?.(name, "invalid_x_mcp_header");
      continue;
    }
    seen.add(name);
    const action = tool.action === "read" || tool.action === "write" || tool.action === "delete" ? tool.action : undefined;
    out.push({
      name,
      title: typeof tool.title === "string" ? clip(tool.title, 200) : "",
      description: typeof tool.description === "string" ? clip(tool.description, MAX_DESCRIPTION) : "",
      inputSchema: schema.type === "object" ? schema : { ...schema, type: "object" },
      ...(action ? { action } : {}),
    });
    if (out.length >= MCP_MAX_TOOLS) break;
  }
  return out;
}

function truncate(text: string): string {
  if (text.length <= MCP_MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MCP_MAX_TOOL_RESULT_CHARS)}\n[truncated: ${text.length - MCP_MAX_TOOL_RESULT_CHARS} more characters]`;
}

function contentText(item: JsonMap): string {
  if (item.type === "text" && typeof item.text === "string") return item.text;
  if (item.type === "image" || item.type === "audio") {
    return `[${item.type} omitted${typeof item.mimeType === "string" ? `: ${item.mimeType}` : ""}]`;
  }
  if (item.type === "resource") {
    const resource = asMap(item.resource);
    if (typeof resource?.text === "string") return resource.text;
    return `[resource${typeof resource?.uri === "string" ? `: ${resource.uri}` : ""}]`;
  }
  if (item.type === "resource_link") {
    const label = [item.name, item.uri].filter((part) => typeof part === "string" && part).join(" ");
    return `[resource link${label ? `: ${label}` : ""}]`;
  }
  return "";
}

export function toolOutcome(result: unknown): McpToolOutcome {
  const rec = asMap(result) ?? {};
  const content = Array.isArray(rec.content) ? rec.content : [];
  const parts = content.flatMap((item) => {
    const map = asMap(item);
    const text = map ? contentText(map) : "";
    return text ? [text] : [];
  });
  let text = parts.join("\n\n");
  if (!text && rec.structuredContent !== undefined) text = JSON.stringify(rec.structuredContent);
  const isError = rec.isError === true;
  if (!text) text = isError ? "The tool reported an error without details." : "The tool returned no content.";
  return { text: truncate(text), isError };
}

export class McpClient {
  private era: McpEra | null;
  private confirmed = false;
  private requested = MCP_LEGACY_PROTOCOL_VERSION;
  private negotiated = "";
  private sessionId = "";
  private nextId = 1;
  private ready: Promise<string> | null = null;
  private channel: SseChannel | null = null;
  private modernReason: McpError | null = null;
  private readonly tried = new Set<McpEra>();
  private readonly auth: McpAuth;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly options: ClientOptions) {
    this.auth = options.auth ?? NO_AUTH;
    this.era = eraOf(options.connection);
    this.timeoutMs = options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? MCP_MAX_RESPONSE_BYTES;
  }

  get connection(): McpConnection | null {
    if (!this.confirmed || !this.era) return null;
    if (this.era === "modern") return { transport: "streamable_http", protocolVersion: MCP_PROTOCOL_VERSION };
    return { transport: this.era === "sse" ? "sse" : "streamable_http", protocolVersion: this.negotiated };
  }

  private signal(outer?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return outer ? AbortSignal.any([outer, timeout]) : timeout;
  }

  private async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    let retried = false;
    for (;;) {
      const auth = await this.auth.headers(signal);
      const res = await this.options.fetch(url, {
        method,
        headers: { ...auth, ...headers },
        ...(body === undefined ? {} : { body }),
        signal,
      });
      if (res.status !== 401 && res.status !== 403) return res;
      const challenge = bearerChallenge(res.headers.get("www-authenticate"));
      await cancelQuietly(res.body);
      if (res.status === 403 && challenge?.error === "insufficient_scope") {
        throw new McpError("MCP_AUTH_SCOPE", challenge.scope, { challenge });
      }
      if (res.status === 401 && !retried && (await this.auth.rejected(challenge, signal))) {
        retried = true;
        continue;
      }
      throw new McpError("MCP_AUTH_FAILED", `HTTP ${res.status}`, { challenge });
    }
  }

  private async errorBody(res: Response): Promise<JsonRpcMessage | null> {
    const text = await readLimitedText(res, MAX_ERROR_BODY_BYTES).catch(() => "");
    const parsed = parseJsonOrNull(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return (list.find((item) => asMap(asMap(item)?.error)) as JsonRpcMessage | undefined) ?? null;
  }

  private async answer(message: JsonRpcMessage, signal: AbortSignal): Promise<void> {
    const reply = legacyReply(message);
    if (!reply) return;
    const res = await this.send("POST", this.options.url, this.legacyHeaders(), JSON.stringify(reply), signal).catch(
      () => null,
    );
    await cancelQuietly(res?.body);
  }

  private async resume(lastEventId: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    const headers = { ...this.sessionHeaders(), Accept: "text/event-stream", "Last-Event-ID": lastEventId };
    const res = await this.send("GET", this.options.url, headers, undefined, signal);
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (res.ok && res.body && type.includes("text/event-stream")) return res.body;
    await cancelQuietly(res.body);
    return null;
  }

  private async response(res: Response, id: number, signal: AbortSignal, legacy: boolean): Promise<JsonRpcMessage> {
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!type.includes("text/event-stream") || !res.body) {
      const match = parseMessages(await readLimitedText(res, this.maxBytes)).find((message) => isAnswer(message, id));
      if (!match) throw new McpError("MCP_PROTOCOL_ERROR", "missing response");
      return match;
    }
    let body: ReadableStream<Uint8Array> | null = res.body;
    let lastEventId: string | null = null;
    let retry = DEFAULT_RETRY_MS;
    for (let resumes = 0; body; resumes++) {
      for await (const event of sseEvents(body, { total: this.maxBytes, event: this.maxBytes })) {
        if (event.id !== null) lastEventId = event.id;
        if (event.retry !== null) retry = event.retry;
        if (!event.data.trim()) continue;
        for (const message of parseMessages(event.data)) {
          if (isAnswer(message, id)) return message;
          if (legacy) await this.answer(message, signal);
        }
      }
      if (!legacy || lastEventId === null || resumes >= MAX_RESUMES) break;
      await delay(Math.min(retry, MAX_RETRY_MS), undefined, { signal });
      body = await this.resume(lastEventId, signal);
    }
    throw new McpError("MCP_PROTOCOL_ERROR", "stream ended without a response");
  }

  private modernFailure(status: number, message: JsonRpcMessage | null, method: string): Error {
    const code = rpcCode(message);
    if (code === UNSUPPORTED_VERSION) {
      const raw = asMap(message?.error?.data)?.supported;
      const supported = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
      const legacy = supported.find((version) => version && !isModernVersion(version));
      const reason = new McpError("MCP_VERSION_UNSUPPORTED", clip(supported.join(", "), 200), { rpcCode: code });
      return legacy ? new EraSwitch("legacy", reason, legacy) : reason;
    }
    if (code !== null && MODERN_ERRORS.has(code)) return rpcError(message!);
    const reason =
      message?.error ? rpcError(message) : new McpError(status >= 300 ? "MCP_HTTP_ERROR" : "MCP_PROTOCOL_ERROR", `HTTP ${status}`);
    if (code === METHOD_NOT_FOUND && method === "server/discover") return new EraSwitch("legacy", reason);
    if (status === 404 && code === METHOD_NOT_FOUND) return reason;
    if (FALLBACK_STATUS.has(status)) return new EraSwitch("legacy", reason);
    return reason;
  }

  private async modern(method: string, params: JsonMap, outer?: AbortSignal, extra: Record<string, string> = {}): Promise<JsonMap> {
    const id = this.nextId++;
    const signal = this.signal(outer);
    const meta = {
      ...(asMap(params._meta) ?? {}),
      [META_VERSION]: MCP_PROTOCOL_VERSION,
      [META_CLIENT]: CLIENT_INFO,
      [META_CAPABILITIES]: this.options.capabilities ?? {},
    };
    const nameKey = NAMED_PARAMS[method];
    const named = nameKey ? params[nameKey] : undefined;
    const headers: Record<string, string> = {
      ...JSON_HEADERS,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "Mcp-Method": method,
      ...(typeof named === "string" ? { "Mcp-Name": headerValue(named) } : {}),
      ...extra,
    };
    const payload = { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } };
    const res = await this.send("POST", this.options.url, headers, JSON.stringify(payload), signal);
    if (!res.ok) throw this.modernFailure(res.status, await this.errorBody(res), method);
    const message = await this.response(res, id, signal, false);
    if (message.error) throw this.modernFailure(200, message, method);
    return complete(message.result);
  }

  private sessionHeaders(): Record<string, string> {
    return {
      ...(this.negotiated ? { "MCP-Protocol-Version": this.negotiated } : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
  }

  private legacyHeaders(): Record<string, string> {
    return { ...JSON_HEADERS, ...this.sessionHeaders() };
  }

  private initializeFailure(status: number, message: JsonRpcMessage | null): Error {
    const code = rpcCode(message);
    const reason = message?.error ? rpcError(message) : new McpError("MCP_HTTP_ERROR", `HTTP ${status}`);
    if (code !== null && MODERN_ERRORS.has(code)) return new EraSwitch("modern", reason);
    if (FALLBACK_STATUS.has(status)) return new EraSwitch("sse", reason);
    return reason;
  }

  private async legacyExchange(method: string, params: JsonMap, outer?: AbortSignal): Promise<JsonMap> {
    const id = this.nextId++;
    const signal = this.signal(outer);
    const initialize = method === "initialize";
    const res = await this.send(
      "POST",
      this.options.url,
      this.legacyHeaders(),
      JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    );
    if (res.status === 404 && this.sessionId && !initialize) {
      await cancelQuietly(res.body);
      throw new McpError("MCP_HTTP_ERROR", "session expired");
    }
    if (!res.ok) {
      if (initialize) throw this.initializeFailure(res.status, await this.errorBody(res));
      await cancelQuietly(res.body);
      throw new McpError("MCP_HTTP_ERROR", `HTTP ${res.status}`);
    }
    if (initialize) this.sessionId = res.headers.get("mcp-session-id")?.trim() ?? "";
    const message = await this.response(res, id, signal, true);
    if (message.error) throw initialize ? this.initializeFailure(200, message) : rpcError(message);
    return complete(message.result);
  }

  private async legacyNotify(method: string, outer?: AbortSignal): Promise<void> {
    const res = await this.send(
      "POST",
      this.options.url,
      this.legacyHeaders(),
      JSON.stringify({ jsonrpc: "2.0", method }),
      this.signal(outer),
    );
    await cancelQuietly(res.body);
    if (!res.ok) throw new McpError("MCP_HTTP_ERROR", `HTTP ${res.status}`);
  }

  private initializeParams(): JsonMap {
    return { protocolVersion: this.requested, capabilities: {}, clientInfo: CLIENT_INFO };
  }

  private negotiate(result: JsonMap): void {
    const version = typeof result.protocolVersion === "string" ? result.protocolVersion : "";
    if (!version) throw new McpError("MCP_PROTOCOL_ERROR", "missing protocolVersion");
    this.negotiated = version;
  }

  private async legacyHandshake(outer?: AbortSignal): Promise<string> {
    this.sessionId = "";
    this.negotiated = "";
    const result = await this.legacyExchange("initialize", this.initializeParams(), outer);
    this.negotiate(result);
    await this.legacyNotify("notifications/initialized", outer);
    return nameOf(asMap(result.serverInfo));
  }

  private async sseHandshake(outer?: AbortSignal): Promise<string> {
    this.channel?.close();
    this.negotiated = "";
    const channel = new SseChannel({
      url: this.options.url,
      send: (method, url, headers, body, signal) => this.send(method, url, headers, body, signal),
      maxBytes: this.maxBytes,
      parse: parseMessages,
      answer: legacyReply,
    });
    this.channel = channel;
    const signal = this.signal(outer);
    try {
      await channel.open(signal);
    } catch (err) {
      if (err instanceof McpError && (err.code === "MCP_HTTP_ERROR" || err.code === "MCP_PROTOCOL_ERROR")) {
        throw new EraSwitch("modern", err);
      }
      throw err;
    }
    const message = await channel.request({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: this.initializeParams() }, signal);
    if (message.error) throw rpcError(message);
    const result = complete(message.result);
    this.negotiate(result);
    await channel.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
    return nameOf(asMap(result.serverInfo));
  }

  private handshake(era: Exclude<McpEra, "modern">, outer?: AbortSignal): Promise<string> {
    if (!this.ready) {
      const started = era === "legacy" ? this.legacyHandshake(outer) : this.sseHandshake(outer);
      this.ready = started;
      started.catch(() => {
        if (this.ready === started) this.ready = null;
      });
    }
    return this.ready;
  }

  private async legacy(method: string, params: JsonMap, outer?: AbortSignal): Promise<JsonMap> {
    await this.handshake("legacy", outer);
    try {
      return await this.legacyExchange(method, params, outer);
    } catch (err) {
      if (!(err instanceof McpError) || err.detail !== "session expired") throw err;
      this.ready = null;
      await this.handshake("legacy", outer);
      return this.legacyExchange(method, params, outer);
    }
  }

  private async overSse(method: string, params: JsonMap, outer?: AbortSignal): Promise<JsonMap> {
    await this.handshake("sse", outer);
    const message = await this.channel!.request({ jsonrpc: "2.0", id: this.nextId++, method, params }, this.signal(outer));
    if (message.error) throw rpcError(message);
    return complete(message.result);
  }

  private switchTo(from: McpEra, change: EraSwitch): void {
    if ((this.era ?? "modern") !== from) return;
    this.tried.add(from);
    if (from === "modern") this.modernReason = change.reason;
    if (this.tried.has(change.era)) throw this.modernReason ?? change.reason;
    this.era = change.era;
    if (change.version) this.requested = change.version;
    this.confirmed = false;
    this.ready = null;
    this.sessionId = "";
    this.negotiated = "";
    this.channel?.close();
    this.channel = null;
  }

  private async run<T>(work: (era: McpEra) => Promise<T>): Promise<T> {
    for (;;) {
      const era = this.era ?? "modern";
      try {
        const out = await work(era);
        this.era = era;
        this.confirmed = true;
        return out;
      } catch (err) {
        if (!(err instanceof EraSwitch)) throw err;
        this.switchTo(era, err);
      }
    }
  }

  private request(method: string, params: JsonMap, outer?: AbortSignal, extra: Record<string, string> = {}): Promise<JsonMap> {
    return this.run((era) => {
      if (era === "modern") return this.modern(method, params, outer, extra);
      if (era === "legacy") return this.legacy(method, params, outer);
      return this.overSse(method, params, outer);
    });
  }

  discover(outer?: AbortSignal): Promise<string> {
    return this.run(async (era) => {
      if (era !== "modern") return this.handshake(era, outer);
      const result = await this.modern("server/discover", {}, outer);
      return nameOf(asMap(asMap(result._meta)?.[META_SERVER]));
    });
  }

  async listTools(outer?: AbortSignal, onReject?: (name: string, reason: string) => void): Promise<McpToolSpec[]> {
    const raw: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, outer);
      if (Array.isArray(result.tools)) raw.push(...result.tools);
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor || raw.length >= MCP_MAX_TOOLS) break;
    }
    return toolSpecs(raw, onReject);
  }

  async callTool(name: string, args: JsonMap, outer?: AbortSignal, schema?: JsonMap): Promise<McpToolOutcome> {
    const call = (input: JsonMap | undefined) =>
      this.request("tools/call", { name, arguments: args }, outer, input ? paramHeaders(headerParams(input) ?? [], args) : {});
    try {
      return toolOutcome(await call(schema));
    } catch (err) {
      if (!(err instanceof McpError) || err.rpcCode !== HEADER_MISMATCH) throw err;
      const fresh = (await this.listTools(outer)).find((tool) => tool.name === name);
      if (!fresh) throw err;
      return toolOutcome(await call(fresh.inputSchema));
    }
  }

  async close(): Promise<boolean> {
    this.channel?.close();
    this.channel = null;
    const headers = this.sessionHeaders();
    const session = this.sessionId;
    this.ready = null;
    this.sessionId = "";
    if (!session) return false;
    try {
      const res = await this.send("DELETE", this.options.url, headers, undefined, AbortSignal.timeout(CLOSE_TIMEOUT_MS));
      await cancelQuietly(res.body);
      return res.ok;
    } catch {
      return false;
    }
  }
}
