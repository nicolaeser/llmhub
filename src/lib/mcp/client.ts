import { McpError } from "@/lib/mcp/errors";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cancelQuietly } from "@/lib/utils/streams";
import type { JsonMap } from "@/types/gateway";
import type { JsonRpcMessage, McpFetch, McpToolOutcome, McpToolSpec } from "@/types/mcp";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MCP_MAX_TOOLS = 200;
export const MCP_MAX_TOOL_RESULT_CHARS = 16_000;

const MAX_PAGES = 20;
const MAX_TOOL_NAME = 128;
const MAX_DESCRIPTION = 2_000;
const MAX_SCHEMA_BYTES = 32_000;
const CLIENT_INFO = { name: "llmhub", version: "1.0.0" };

type ClientOptions = {
  url: string;
  headers: Record<string, string>;
  fetch: McpFetch;
  timeoutMs?: number;
  maxBytes?: number;
};

function asMap(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : null;
}

async function* readChunks(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new McpError("MCP_RESPONSE_TOO_LARGE");
      yield decoder.decode(value, { stream: true });
    }
    drained = true;
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    if (!drained) await cancelQuietly(reader);
  }
}

export async function readLimitedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  let text = "";
  for await (const chunk of readChunks(res.body, maxBytes)) text += chunk;
  return text;
}

export async function* sseData(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<string> {
  let buffer = "";
  const flush = function* (final: boolean): Generator<string> {
    const normalized = buffer.replace(/\r\n?/g, "\n");
    const blocks = normalized.split("\n\n");
    buffer = final ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length) yield data.join("\n");
    }
  };
  for await (const chunk of readChunks(body, maxBytes)) {
    buffer += chunk;
    yield* flush(false);
  }
  yield* flush(true);
}

function parseMessages(text: string): JsonRpcMessage[] {
  const parsed = parseJsonOrNull(text);
  if (parsed === null) throw new McpError("MCP_PROTOCOL_ERROR", "invalid JSON");
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.flatMap((item) => (asMap(item) ? [item as JsonRpcMessage] : []));
}

function settle(message: JsonRpcMessage): unknown {
  if (message.error) {
    const detail = typeof message.error.message === "string" ? message.error.message.slice(0, 300) : "";
    throw new McpError("MCP_RPC_ERROR", detail);
  }
  return message.result ?? {};
}

function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

export function toolSpecs(raw: unknown): McpToolSpec[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: McpToolSpec[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const tool = asMap(item);
    const name = typeof tool?.name === "string" ? tool.name.trim() : "";
    if (!tool || !name || name.length > MAX_TOOL_NAME || seen.has(name)) continue;
    const schema = asMap(tool.inputSchema) ?? { type: "object", properties: {} };
    if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) continue;
    seen.add(name);
    out.push({
      name,
      title: typeof tool.title === "string" ? clip(tool.title, 200) : "",
      description: typeof tool.description === "string" ? clip(tool.description, MAX_DESCRIPTION) : "",
      inputSchema: schema.type === "object" ? schema : { ...schema, type: "object" },
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
  private sessionId = "";
  private protocolVersion = "";
  private nextId = 1;
  private ready: Promise<string> | null = null;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly options: ClientOptions) {
    this.timeoutMs = options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? MCP_MAX_RESPONSE_BYTES;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.options.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private signal(outer?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return outer ? AbortSignal.any([outer, timeout]) : timeout;
  }

  private async post(payload: JsonMap, signal: AbortSignal): Promise<Response> {
    const res = await this.options.fetch(this.options.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      await cancelQuietly(res.body);
      throw new McpError("MCP_AUTH_FAILED", `HTTP ${res.status}`);
    }
    return res;
  }

  private async exchange(method: string, params: JsonMap, outer?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const signal = this.signal(outer);
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    if (res.status === 404 && this.sessionId && method !== "initialize") {
      await cancelQuietly(res.body);
      throw new McpError("MCP_HTTP_ERROR", "session expired");
    }
    if (!res.ok) {
      await cancelQuietly(res.body);
      throw new McpError("MCP_HTTP_ERROR", `HTTP ${res.status}`);
    }
    if (method === "initialize") this.sessionId = res.headers.get("mcp-session-id")?.trim() ?? "";
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("text/event-stream") && res.body) {
      for await (const data of sseData(res.body, this.maxBytes)) {
        if (!data.trim()) continue;
        for (const message of parseMessages(data)) {
          if (message.id === id && (message.result !== undefined || message.error)) return settle(message);
        }
      }
      throw new McpError("MCP_PROTOCOL_ERROR", "stream ended without a response");
    }
    const text = await readLimitedText(res, this.maxBytes);
    const match = parseMessages(text).find((message) => message.id === id);
    if (!match) throw new McpError("MCP_PROTOCOL_ERROR", "missing response");
    return settle(match);
  }

  private async notify(method: string, outer?: AbortSignal): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", method }, this.signal(outer));
    await cancelQuietly(res.body);
    if (!res.ok) throw new McpError("MCP_HTTP_ERROR", `HTTP ${res.status}`);
  }

  private async handshake(outer?: AbortSignal): Promise<string> {
    this.sessionId = "";
    this.protocolVersion = "";
    const result = asMap(
      await this.exchange(
        "initialize",
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        outer,
      ),
    );
    const version = typeof result?.protocolVersion === "string" ? result.protocolVersion : "";
    if (!version) throw new McpError("MCP_PROTOCOL_ERROR", "missing protocolVersion");
    this.protocolVersion = version;
    await this.notify("notifications/initialized", outer);
    const info = asMap(result?.serverInfo);
    return typeof info?.name === "string" ? clip(info.name, 200) : "";
  }

  initialize(outer?: AbortSignal): Promise<string> {
    if (!this.ready) {
      this.ready = this.handshake(outer);
      this.ready.catch(() => {
        this.ready = null;
      });
    }
    return this.ready;
  }

  private async request(method: string, params: JsonMap, outer?: AbortSignal): Promise<unknown> {
    await this.initialize(outer);
    try {
      return await this.exchange(method, params, outer);
    } catch (err) {
      if (!(err instanceof McpError) || err.detail !== "session expired") throw err;
      this.ready = null;
      await this.initialize(outer);
      return this.exchange(method, params, outer);
    }
  }

  async listTools(outer?: AbortSignal): Promise<McpToolSpec[]> {
    const raw: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = asMap(await this.request("tools/list", cursor ? { cursor } : {}, outer));
      if (Array.isArray(result?.tools)) raw.push(...result.tools);
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor || raw.length >= MCP_MAX_TOOLS) break;
    }
    return toolSpecs(raw);
  }

  async callTool(name: string, args: JsonMap, outer?: AbortSignal): Promise<McpToolOutcome> {
    return toolOutcome(await this.request("tools/call", { name, arguments: args }, outer));
  }

  async close(): Promise<boolean> {
    const session = this.sessionId;
    this.ready = null;
    this.sessionId = "";
    if (!session) return false;
    try {
      const res = await this.options.fetch(this.options.url, {
        method: "DELETE",
        headers: { ...this.options.headers, "Mcp-Session-Id": session, "MCP-Protocol-Version": this.protocolVersion },
        signal: AbortSignal.timeout(5_000),
      });
      await cancelQuietly(res.body);
      return res.ok;
    } catch {
      return false;
    }
  }
}
