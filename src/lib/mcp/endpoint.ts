import { GateError } from "@/lib/gateway/errors";
import { isPayloadTooLarge, readText } from "@/lib/http/api";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import {
  HEADER_MISMATCH,
  isModernVersion,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  META_CAPABILITIES,
  META_SERVER,
  META_VERSION,
  METHOD_NOT_FOUND,
  NAMED_PARAMS,
  UNSUPPORTED_VERSION,
} from "@/lib/mcp/client";
import { decodeHeaderValue } from "@/lib/mcp/headers";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { JsonMap } from "@/types/gateway";

export const MCP_ENDPOINT_MAX_BYTES = 4 * 1024 * 1024;
export const MCP_ENDPOINT_MAX_BATCH = 64;
export const MCP_DISCOVER_TTL_MS = 60 * 60 * 1000;
export const MCP_TOOLS_TTL_MS = 60 * 1000;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const GATEWAY_REFUSED = -32001;

export type McpEndpointTools = {
  info: { name: string; version: string };
  instructions?: string;
  list(signal: AbortSignal): Promise<JsonMap[]>;
  call(name: string, args: JsonMap, signal: AbortSignal): Promise<JsonMap>;
};

export type McpReply = { status: number; body: JsonMap | JsonMap[] | null };

export class McpEndpointError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpEndpointError";
  }
}

type Message = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

function asMap(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : null;
}

function isRequestId(id: unknown): id is string | number {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

export function rpcFailure(id: unknown, code: number, message: string, data?: unknown): JsonMap {
  return {
    jsonrpc: "2.0",
    id: isRequestId(id) ? id : null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function rpcSuccess(id: string | number, result: JsonMap): JsonMap {
  return { jsonrpc: "2.0", id, result };
}

function failureOf(id: string | number, err: unknown): JsonMap {
  if (err instanceof McpEndpointError) return rpcFailure(id, err.code, err.message, err.data);
  if (err instanceof GateError) return rpcFailure(id, GATEWAY_REFUSED, err.message, { status: err.status, code: err.code });
  logger.error("mcp.endpoint_failed", errorFields(err));
  return rpcFailure(id, INTERNAL_ERROR, "Internal error");
}

function argumentsOf(value: unknown): JsonMap {
  if (typeof value === "string") return asMap(parseJsonOrNull(value)) ?? {};
  return asMap(value) ?? {};
}

async function callTool(tools: McpEndpointTools, params: JsonMap, signal: AbortSignal): Promise<JsonMap> {
  const name = typeof params.name === "string" ? params.name : "";
  if (!name) throw new McpEndpointError(INVALID_PARAMS, "Missing tool name");
  return tools.call(name, argumentsOf(params.arguments), signal);
}

function unsupportedVersion(id: unknown, requested: string): McpReply {
  return {
    status: 400,
    body: rpcFailure(id, UNSUPPORTED_VERSION, "Unsupported protocol version", {
      supported: MCP_SUPPORTED_PROTOCOL_VERSIONS,
      requested,
    }),
  };
}

function initializeResult(tools: McpEndpointTools, params: JsonMap): JsonMap {
  const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  const protocolVersion = MCP_LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_LEGACY_PROTOCOL_VERSIONS[0]!;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: tools.info,
    ...(tools.instructions ? { instructions: tools.instructions } : {}),
  };
}

export async function answerLegacy(raw: unknown, tools: McpEndpointTools, signal: AbortSignal): Promise<JsonMap | null> {
  const message = asMap(raw) as Message | null;
  if (!message || (message as JsonMap).jsonrpc !== "2.0") return rpcFailure(null, INVALID_REQUEST, "Invalid Request");
  if (message.method === undefined) {
    return message.result !== undefined || message.error !== undefined ? null : rpcFailure(message.id, INVALID_REQUEST, "Invalid Request");
  }
  if (typeof message.method !== "string") return rpcFailure(message.id, INVALID_REQUEST, "Invalid Request");
  if (message.id === undefined) return null;
  if (!isRequestId(message.id)) return rpcFailure(null, INVALID_REQUEST, "Invalid request id");
  const id = message.id;
  const params = asMap(message.params) ?? {};
  try {
    if (message.method === "initialize") return rpcSuccess(id, initializeResult(tools, params));
    if (message.method === "ping") return rpcSuccess(id, {});
    if (message.method === "tools/list") return rpcSuccess(id, { tools: await tools.list(signal) });
    if (message.method === "tools/call") return rpcSuccess(id, await callTool(tools, params, signal));
    return rpcFailure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  } catch (err) {
    return failureOf(id, err);
  }
}

export async function answerLegacyBatch(raw: unknown, tools: McpEndpointTools, signal: AbortSignal): Promise<JsonMap[]> {
  if (!Array.isArray(raw)) {
    const reply = await answerLegacy(raw, tools, signal);
    return reply ? [reply] : [];
  }
  if (!raw.length || raw.length > MCP_ENDPOINT_MAX_BATCH) return [rpcFailure(null, INVALID_REQUEST, "Invalid batch")];
  const replies = await Promise.all(raw.map((item) => answerLegacy(item, tools, signal)));
  return replies.filter((reply): reply is JsonMap => reply !== null);
}

function headerMismatch(headers: Headers, version: string, method: string, params: JsonMap): string {
  const headerVersion = headers.get("mcp-protocol-version");
  if (headerVersion !== version) return `MCP-Protocol-Version header ${headerVersion === null ? "is missing" : "does not match the body"}`;
  const headerMethod = headers.get("mcp-method");
  if (headerMethod !== method) return `Mcp-Method header ${headerMethod === null ? "is missing" : "does not match the body"}`;
  const nameKey = NAMED_PARAMS[method];
  if (!nameKey) return "";
  const headerName = headers.get("mcp-name");
  if (headerName === null) return "Mcp-Name header is missing";
  return decodeHeaderValue(headerName) === params[nameKey] ? "" : "Mcp-Name header does not match the body";
}

async function modernResult(method: string, params: JsonMap, tools: McpEndpointTools, signal: AbortSignal): Promise<JsonMap | null> {
  if (method === "server/discover") {
    return {
      supportedVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
      capabilities: { tools: {} },
      ...(tools.instructions ? { instructions: tools.instructions } : {}),
      ttlMs: MCP_DISCOVER_TTL_MS,
      cacheScope: "public",
    };
  }
  if (method === "tools/list") return { tools: await tools.list(signal), ttlMs: MCP_TOOLS_TTL_MS, cacheScope: "private" };
  if (method === "tools/call") return callTool(tools, params, signal);
  return null;
}

async function answerModern(message: Message, version: string, headers: Headers, tools: McpEndpointTools, signal: AbortSignal): Promise<McpReply> {
  if (message.id === undefined) return { status: 202, body: null };
  if (!isRequestId(message.id)) return { status: 400, body: rpcFailure(null, INVALID_REQUEST, "Invalid request id") };
  const id = message.id;
  const method = message.method as string;
  const params = asMap(message.params) ?? {};
  const mismatch = headerMismatch(headers, version, method, params);
  if (mismatch) return { status: 400, body: rpcFailure(id, HEADER_MISMATCH, `Header mismatch: ${mismatch}`) };
  if (version !== MCP_PROTOCOL_VERSION) return unsupportedVersion(id, version);
  if (!asMap(asMap(params._meta)?.[META_CAPABILITIES])) {
    return { status: 400, body: rpcFailure(id, INVALID_PARAMS, `Missing _meta.${META_CAPABILITIES}`) };
  }
  try {
    const result = await modernResult(method, params, tools, signal);
    if (!result) return { status: 404, body: rpcFailure(id, METHOD_NOT_FOUND, `Method not found: ${method}`) };
    const meta = { ...(asMap(result._meta) ?? {}), [META_SERVER]: tools.info };
    return { status: 200, body: rpcSuccess(id, { resultType: "complete", ...result, _meta: meta }) };
  } catch (err) {
    return { status: 200, body: failureOf(id, err) };
  }
}

function legacyHeaderProblem(headers: Headers, method: unknown): McpReply | null {
  const headerVersion = headers.get("mcp-protocol-version");
  if (headerVersion === null || method === "initialize" || MCP_LEGACY_PROTOCOL_VERSIONS.includes(headerVersion)) return null;
  if (isModernVersion(headerVersion)) {
    return { status: 400, body: rpcFailure(null, HEADER_MISMATCH, `Header mismatch: request body has no _meta.${META_VERSION}`) };
  }
  return unsupportedVersion(null, headerVersion);
}

export async function answerMcp(raw: unknown, headers: Headers, tools: McpEndpointTools, signal: AbortSignal): Promise<McpReply> {
  if (Array.isArray(raw)) {
    const replies = await answerLegacyBatch(raw, tools, signal);
    return replies.length ? { status: 200, body: replies } : { status: 202, body: null };
  }
  const message = asMap(raw) as Message | null;
  if (!message || (message as JsonMap).jsonrpc !== "2.0") return { status: 400, body: rpcFailure(null, INVALID_REQUEST, "Invalid Request") };
  const version = asMap(asMap(message.params)?._meta)?.[META_VERSION];
  if (typeof version === "string" && typeof message.method === "string") {
    return answerModern(message, version, headers, tools, signal);
  }
  const problem = legacyHeaderProblem(headers, message.method);
  if (problem) return problem;
  const reply = await answerLegacy(message, tools, signal);
  if (!reply) return { status: 202, body: null };
  const invalid = asMap(reply.error)?.code === INVALID_REQUEST;
  return { status: invalid ? 400 : 200, body: reply };
}

export async function readMcpMessage(req: Request): Promise<unknown> {
  let text: string;
  try {
    text = await readText(req, MCP_ENDPOINT_MAX_BYTES);
  } catch (err) {
    if (isPayloadTooLarge(err)) throw new GateError(413, "payload_too_large", "request body is too large");
    throw err;
  }
  const parsed = parseJsonOrNull(text);
  if (parsed === null) throw new McpEndpointError(PARSE_ERROR, "Parse error");
  return parsed;
}

export function mcpReplyResponse(reply: McpReply): Response {
  if (reply.body === null) return new Response(null, { status: reply.status });
  return Response.json(reply.body, { status: reply.status });
}

export async function serveMcpPost(req: Request, tools: McpEndpointTools): Promise<Response> {
  let raw: unknown;
  try {
    raw = await readMcpMessage(req);
  } catch (err) {
    if (err instanceof McpEndpointError) return mcpReplyResponse({ status: 400, body: rpcFailure(null, err.code, err.message) });
    throw err;
  }
  return mcpReplyResponse(await answerMcp(raw, req.headers, tools, req.signal));
}

export function methodNotAllowed(): Response {
  return Response.json(rpcFailure(null, INVALID_REQUEST, "Method not allowed"), { status: 405, headers: { Allow: "POST" } });
}

export function acceptsEventStream(req: Request): boolean {
  return (req.headers.get("accept") ?? "").toLowerCase().includes("text/event-stream");
}
