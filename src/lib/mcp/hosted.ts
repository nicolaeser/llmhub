import { parseJsonOrNull } from "@/lib/utils/json";
import { MAX_HOSTED_TOOLS, MCP_ACTIONS, MCP_HTTP_METHODS, hostedToolSchema, mcpDraftBaseSchema } from "@/schemas/mcp";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import type { JsonMap } from "@/types/gateway";
import type {
  HostedSpec,
  HostedTool,
  McpBuilderTemplate,
  McpDraftReading,
  McpDraftServer,
  McpFetch,
  McpToolAction,
  McpToolOutcome,
  McpToolSpec,
} from "@/types/mcp";

export const BUILDER_SYSTEM = `You turn API documentation into one MCP server for an API that does not already provide MCP.
Return one JSON object and nothing else. No markdown.
Shape, with the server fields before tools:
{"name":"short name","description":"what it does","baseUrl":"https://api.example.com","internal":false,"authType":"none","authHeader":"","notes":"assumptions","tools":[{"name":"list_pets","title":"List pets","description":"what the call does","action":"read","method":"GET","path":"/pets","query":[],"inputSchema":{"type":"object","properties":{"limit":{"type":"integer","description":"page size"}},"required":[]}}]}
Rules:
- Build one tool for every operation the documentation describes that the request allows. Do not merge, sample, or shorten the list.
- Include only operations the documentation describes.
- The documentation can come as several labeled sources and attached files. Combine them into one server.
- action is read for safe reads, write for creates and updates, delete for deletes and irreversible changes.
- path is relative to baseUrl, starts with /, and has no query string. Path parameters use {name}; that name is a string property in inputSchema.
- Query and body fields are properties of inputSchema. For POST, PUT, and PATCH, list the query string fields in query.
- Keep each description to one sentence and each inputSchema to the fields the call takes.
- Prefer the operations the operator asked for. Skip operations they told you not to build.
- At most ${MAX_HOSTED_TOOLS} tools.
- authType is none, bearer, or header. authHeader is only the header name when authType is header. Do not invent secrets.
- internal is true only when the base URL is http or on a private network.`;

export const PICK_SYSTEM = `You choose which operations of an API become MCP tools.
Return one JSON object and nothing else. No markdown.
Shape: {"keep":["operation_name"]}
Keep the operations the request asks for and leave out the ones it rules out. When the request does not narrow the operations, keep all of them.`;

const HOSTED_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const PATH_PARAM = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const QUERY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function asMap(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clip(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit).trimEnd() : value;
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

export function continuePrompt(listed: string[]): string {
  return `Your previous answer stopped before the end. These tools already exist: ${listed.join(", ")}.
Return the same JSON shape with only the operations that are still missing. Return "tools":[] when none are missing.`;
}

export function cleanToolName(raw: string): string {
  const value = raw.trim();
  if (TOOL_NAME.test(value)) return value;
  const snake = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const named = /^[a-z]/.test(snake) ? snake : `op_${snake}`;
  return named.slice(0, 64).replace(/_+$/, "");
}

export function cleanParamName(raw: string): string {
  const snake = raw.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const named = /^[A-Za-z]/.test(snake) ? snake : `p_${snake}`;
  return named.slice(0, 64).replace(/_+$/, "");
}

export function actionOfMethod(method: HostedTool["method"]): McpToolAction {
  if (method === "GET") return "read";
  if (method === "DELETE") return "delete";
  return "write";
}

export function templateAllows(template: McpBuilderTemplate, action: McpToolAction): boolean {
  if (template === "readonly") return action === "read";
  if (template === "writes") return action !== "delete";
  return true;
}

function jsonSource(answer: string): string {
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  const source = fenced?.[1] ?? answer;
  const start = source.indexOf("{");
  return start < 0 ? "" : source.slice(start);
}

function completeObjects(source: string, from: number): unknown[] {
  const items: unknown[] = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let at = from; at < source.length; at += 1) {
    const char = source[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") {
      if (depth === 0) start = at;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth < 0) break;
      if (depth === 0 && start >= 0) {
        const item = parseJsonOrNull(source.slice(start, at + 1));
        if (item) items.push(item);
        start = -1;
      }
    } else if (char === "]" && depth === 0) break;
  }
  return items;
}

export function extractJson(answer: string): unknown {
  const source = jsonSource(answer);
  const end = source.lastIndexOf("}");
  return end > 0 ? parseJsonOrNull(source.slice(0, end + 1)) : null;
}

function authOf(value: unknown): McpDraftServer["authType"] {
  const kind = text(value).toLowerCase().replace(/[^a-z]/g, "");
  if (kind === "bearer" || kind === "oauth" || kind === "oauth2" || kind === "token") return "bearer";
  if (kind === "header" || kind === "apikey") return "header";
  return "none";
}

function serverOf(head: JsonMap | null): McpDraftServer | null {
  if (!head) return null;
  const authType = authOf(head.authType);
  const parsed = mcpDraftBaseSchema.safeParse({
    name: clip(text(head.name), 48),
    description: clip(text(head.description), 500),
    baseUrl: clip(text(head.baseUrl), 2048),
    internal: head.internal === true,
    authType,
    authHeader: authType === "header" ? clip(text(head.authHeader), 64) : "",
    notes: clip(text(head.notes), 2000),
  });
  return parsed.success ? parsed.data : null;
}

function basePath(baseUrl: string): string {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function locate(raw: string, baseUrl: string): { path: string; query: string[]; renamed: Map<string, string> } | null {
  let value = raw.trim().replace(/^https?:\/\/[^/]+/i, "");
  if (!value) return null;
  const hash = value.indexOf("#");
  if (hash >= 0) value = value.slice(0, hash);
  const mark = value.indexOf("?");
  const query =
    mark >= 0
      ? value
          .slice(mark + 1)
          .split("&")
          .map((part) => part.split("=")[0]!.trim())
          .filter((name) => QUERY_NAME.test(name))
      : [];
  if (mark >= 0) value = value.slice(0, mark);
  value = `/${value}`.replace(/\/{2,}/g, "/");
  const prefix = basePath(baseUrl);
  if (prefix && (value === prefix || value.startsWith(`${prefix}/`))) value = value.slice(prefix.length) || "/";
  value = value.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, "/{$1}");
  const renamed = new Map<string, string>();
  value = value.replace(/\{([^{}]*)\}/g, (_match, inner: string) => {
    const name = cleanParamName(inner);
    renamed.set(inner, name);
    return `{${name}}`;
  });
  return { path: value, query, renamed };
}

export function normalizeTool(item: unknown, baseUrl: string): HostedTool | null {
  const record = asMap(item);
  if (!record) return null;
  const method = MCP_HTTP_METHODS.find((entry) => entry === text(record.method).toUpperCase());
  if (!method) return null;
  const located = locate(text(record.path), baseUrl);
  if (!located) return null;
  const schema = asMap(record.inputSchema) ?? {};
  const properties: JsonMap = { ...(asMap(schema.properties) ?? {}) };
  for (const [raw, name] of located.renamed) {
    if (raw === name || !(raw in properties)) continue;
    if (!(name in properties)) properties[name] = properties[raw];
    delete properties[raw];
  }
  const pathNames = [...located.path.matchAll(PATH_PARAM)].map((match) => match[1]!);
  for (const name of [...pathNames, ...located.query]) {
    if (!asMap(properties[name])) properties[name] = { type: "string" };
  }
  const query = [...new Set([...names(record.query), ...located.query])].filter(
    (name) => QUERY_NAME.test(name) && name in properties,
  );
  const required = [...new Set([...names(schema.required).filter((name) => name in properties), ...pathNames])];
  const inputSchema: JsonMap = { ...schema, type: "object", properties };
  if (required.length) inputSchema.required = required;
  else delete inputSchema.required;
  const action = MCP_ACTIONS.find((entry) => entry === text(record.action).toLowerCase()) ?? actionOfMethod(method);
  const parsed = hostedToolSchema.safeParse({
    name: cleanToolName(text(record.name) || `${method}_${located.path}`),
    title: clip(text(record.title), 200),
    description: clip(text(record.description), 2000),
    action,
    method,
    path: located.path,
    query: query.slice(0, 50),
    inputSchema,
  });
  return parsed.success ? parsed.data : null;
}

function callKey(tool: HostedTool): string {
  return `${tool.method} ${tool.path}`;
}

export function mergeTools(existing: HostedTool[], more: HostedTool[], limit = MAX_HOSTED_TOOLS): HostedTool[] {
  const tools = [...existing];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const tool of more) {
    if (tools.length >= limit) break;
    const taken = byName.get(tool.name);
    if (taken && callKey(taken) === callKey(tool)) continue;
    let name = tool.name;
    for (let suffix = 2; byName.has(name); suffix += 1) name = `${tool.name.slice(0, 60)}_${suffix}`;
    const added = name === tool.name ? tool : { ...tool, name };
    byName.set(name, added);
    tools.push(added);
  }
  return tools;
}

export function readDraft(answer: string): McpDraftReading {
  const source = jsonSource(answer);
  const end = source.lastIndexOf("}");
  const whole = end > 0 ? asMap(parseJsonOrNull(source.slice(0, end + 1))) : null;
  let head = whole;
  let listed: unknown[] = Array.isArray(whole?.tools) ? whole.tools : [];
  if (!whole) {
    const key = source.search(/"tools"\s*:\s*\[/);
    if (key >= 0) {
      head = asMap(parseJsonOrNull(`${source.slice(0, key).replace(/,\s*$/, "")}}`));
      listed = completeObjects(source, source.indexOf("[", key) + 1);
    }
  }
  const server = serverOf(head);
  const tools = listed.flatMap((item) => normalizeTool(item, server?.baseUrl ?? "") ?? []);
  return { server, tools: mergeTools([], tools), cut: !whole };
}

export function readPick(answer: string, tools: HostedTool[]): string[] | null {
  const known = new Set(tools.map((tool) => tool.name));
  const keep = names(asMap(extractJson(answer))?.keep).filter((name) => known.has(name));
  return keep.length ? keep : null;
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
  const inQuery = new Set(tool.query);
  const rest: JsonMap = {};
  for (const [key, value] of Object.entries(args)) {
    if (used.has(key) || !known.has(key)) continue;
    if (!inQuery.has(key)) {
      rest[key] = value;
      continue;
    }
    const encoded = queryValue(value);
    if (encoded !== null) url.searchParams.set(key, encoded);
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
