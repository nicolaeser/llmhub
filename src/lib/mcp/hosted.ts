import { parseJsonOrNull } from "@/lib/utils/json";
import { hostedToolSchema, mcpDraftBaseSchema } from "@/schemas/mcp";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import type { JsonMap } from "@/types/gateway";
import type { HostedSpec, HostedTool, McpDraft, McpFetch, McpToolOutcome, McpToolSpec } from "@/types/mcp";

export const BUILDER_SYSTEM = `You turn API documentation into one MCP server for an API that does not already provide MCP.
Return one JSON object and nothing else. No markdown.
Shape:
{"name":"short name","description":"what it does","baseUrl":"https://api.example.com","internal":false,"authType":"none","authHeader":"","notes":"assumptions","tools":[{"name":"list_pets","title":"List pets","description":"what the call does","action":"read","method":"GET","path":"/pets","inputSchema":{"type":"object","properties":{},"required":[]}}]}
Rules:
- Include only operations the documentation describes.
- action is read for safe reads, write for creates and updates, delete for deletes and irreversible changes.
- Path parameters use {name}. That name is a string property in inputSchema.
- Prefer the operations the operator asked for. Skip operations they told you not to build.
- At most 30 tools.
- authType is none, bearer, or header. authHeader is only the header name when authType is header. Do not invent secrets.
- internal is true only when the base URL is http or on a private network.`;

const HOSTED_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const PATH_PARAM = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function asMap(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : null;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return parseJsonOrNull(source.slice(start, end + 1));
}

function prepareTool(item: unknown): unknown {
  const record = asMap(item);
  if (!record || typeof record.path !== "string") return item;
  const schema = asMap(record.inputSchema) ?? {};
  const properties = { ...(asMap(schema.properties) ?? {}) };
  for (const match of record.path.matchAll(PATH_PARAM)) {
    const name = match[1]!;
    if (!properties[name]) properties[name] = { type: "string" };
  }
  return { ...record, inputSchema: { ...schema, type: "object", properties } };
}

export function parseDraft(text: string): { ok: true; draft: McpDraft } | { ok: false; code: "MCP_BUILDER_DRAFT" | "MCP_BUILDER_EMPTY" } {
  const raw = extractJson(text);
  const base = mcpDraftBaseSchema.safeParse(raw);
  if (!base.success) return { ok: false, code: "MCP_BUILDER_DRAFT" };
  const listed = Array.isArray(asMap(raw)?.tools) ? (asMap(raw)?.tools as unknown[]) : [];
  const tools: HostedTool[] = [];
  const seen = new Set<string>();
  for (const item of listed) {
    const parsed = hostedToolSchema.safeParse(prepareTool(item));
    if (!parsed.success || seen.has(parsed.data.name)) continue;
    seen.add(parsed.data.name);
    tools.push(parsed.data);
    if (tools.length >= 30) break;
  }
  if (!tools.length) return { ok: false, code: "MCP_BUILDER_EMPTY" };
  return { ok: true, draft: { ...base.data, tools } };
}

export function hostedSpec(raw: unknown): HostedSpec {
  const listed = Array.isArray(asMap(raw)?.tools) ? (asMap(raw)?.tools as unknown[]) : [];
  const tools: HostedTool[] = [];
  for (const item of listed) {
    const parsed = hostedToolSchema.safeParse(item);
    if (parsed.success) tools.push(parsed.data);
  }
  return { tools };
}

export function toolSpecOf(tool: HostedTool): McpToolSpec {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { ...tool.inputSchema, type: "object" },
    action: tool.action,
  };
}

function allowedKeys(schema: JsonMap): Set<string> {
  const properties = asMap(schema.properties);
  return new Set(properties ? Object.keys(properties) : []);
}

function queryValue(value: unknown): string | null {
  if (typeof value === "string") return value.slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return null;
  return JSON.stringify(value).slice(0, 2000);
}

export function buildHostedRequest(
  baseUrl: string,
  tool: HostedTool,
  args: JsonMap,
): { url: string; method: string; body?: string } | { error: string } {
  const used = new Set<string>();
  let missing = false;
  const path = tool.path.replace(PATH_PARAM, (_match, name: string) => {
    used.add(name);
    const value = args[name];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      missing = true;
      return "";
    }
    return encodeURIComponent(String(value));
  });
  if (missing || path.includes("..") || !path.startsWith("/") || path.startsWith("//")) return { error: "VALIDATION" };
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { error: "MCP_URL_INVALID" };
  }
  const prefix = base.pathname.replace(/\/$/, "");
  const url = new URL(base.origin);
  url.pathname = `${prefix}${path}`;
  const known = allowedKeys(tool.inputSchema);
  const rest: JsonMap = {};
  for (const [key, value] of Object.entries(args)) {
    if (used.has(key) || !known.has(key)) continue;
    rest[key] = value;
  }
  if (tool.method === "GET" || tool.method === "DELETE") {
    for (const [key, value] of Object.entries(rest)) {
      const text = queryValue(value);
      if (text !== null) url.searchParams.set(key, text);
    }
    return { url: url.toString(), method: tool.method };
  }
  return {
    url: url.toString(),
    method: tool.method,
    ...(Object.keys(rest).length ? { body: JSON.stringify(rest) } : {}),
  };
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value.byteLength;
    chunks.push(step.value);
  }
  await reader.cancel().catch(() => undefined);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 16_000 ? `${text.slice(0, 16_000)}\n[truncated]` : text;
}

export async function callHosted(
  baseUrl: string,
  internal: boolean,
  spec: HostedSpec,
  toolName: string,
  args: JsonMap,
  caller: AbortSignal,
  fetchImpl: McpFetch,
  headers: Record<string, string>,
): Promise<McpToolOutcome> {
  const tool = spec.tools.find((item) => item.name === toolName);
  if (!tool) return { text: "This tool is no longer available.", isError: true };
  const built = buildHostedRequest(baseUrl, tool, args);
  if ("error" in built) return { text: built.error, isError: true };
  const verdict = checkServerUrl(built.url, internal);
  if (!verdict.ok) return { text: verdict.code, isError: true };
  try {
    const response = await fetchImpl(built.url, {
      method: built.method,
      headers: {
        Accept: "application/json",
        ...headers,
        ...(built.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(built.body ? { body: built.body } : {}),
      signal: AbortSignal.any([caller, AbortSignal.timeout(HOSTED_TIMEOUT_MS)]),
    });
    const length = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return { text: "The API response was too large.", isError: true };
    const text = await readLimited(response, MAX_RESPONSE_BYTES);
    if (!response.ok) return { text: text ? `HTTP ${response.status}: ${text}` : `HTTP ${response.status}`, isError: true };
    return { text: text || "The tool returned no content.", isError: false };
  } catch (err) {
    const message = err instanceof Error && /^[A-Z0-9_]+$/.test(err.message) ? err.message : "MCP_UNREACHABLE";
    return { text: message, isError: true };
  }
}
