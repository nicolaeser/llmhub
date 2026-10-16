import { parse as parseYaml } from "yaml";
import { classifySideEffect } from "@/lib/integrations/ingest";
import { cleanParamName, cleanToolName, mergeTools } from "@/lib/mcp/hosted";
import { parseJsonOrNull } from "@/lib/utils/json";
import { hostedToolSchema } from "@/schemas/mcp";
import type { JsonMap } from "@/types/gateway";
import type { HostedTool, McpDraftServer, McpOpenApiImport, McpToolAction } from "@/types/mcp";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const SCHEMA_DEPTHS = [4, 2, 1, 0] as const;
const MAX_SCHEMA_CHARS = 30_000;
const MAX_OPERATIONS = 1_000;
const MAX_ENUM = 50;
const MAX_FIELD_TEXT = 300;
const MAX_REF_HOPS = 16;
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const KEPT_KEYS = ["type", "format", "default", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "nullable"] as const;
const PRIVATE_HOST = /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

type Trail = ReadonlySet<string>;

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
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function yamlOrNull(source: string): unknown {
  try {
    return parseYaml(source, { maxAliasCount: 100 });
  } catch {
    return null;
  }
}

export function readApiDocument(docs: string): JsonMap | null {
  const fenced = docs.trim().match(/^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/);
  const source = (fenced?.[1] ?? docs).trim();
  const value = source.startsWith("{")
    ? parseJsonOrNull(source)
    : /^(?:openapi|swagger)\s*:/m.test(source)
      ? yamlOrNull(source)
      : null;
  const root = asMap(value);
  if (!root || !asMap(root.paths)) return null;
  if (typeof root.openapi !== "string" && root.swagger === undefined) return null;
  return root;
}

function pointer(root: JsonMap, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    node = Array.isArray(node) ? node[Number(key)] : asMap(node)?.[key];
    if (node === undefined) return undefined;
  }
  return node;
}

function deref(root: JsonMap, value: unknown, trail: Trail): { node: JsonMap | null; trail: Trail } {
  let node = asMap(value);
  let seen = trail;
  for (let hop = 0; node && typeof node.$ref === "string"; hop += 1) {
    const ref = node.$ref;
    if (hop >= MAX_REF_HOPS || seen.has(ref)) return { node: null, trail: seen };
    seen = new Set([...seen, ref]);
    node = asMap(pointer(root, ref));
  }
  return { node, trail: seen };
}

function flatten(root: JsonMap, node: JsonMap, trail: Trail): JsonMap {
  if (!Array.isArray(node.allOf)) return node;
  const properties: JsonMap = { ...(asMap(node.properties) ?? {}) };
  const required = new Set(names(node.required));
  let type = node.type;
  let description = text(node.description);
  for (const part of node.allOf) {
    const resolved = deref(root, part, trail);
    if (!resolved.node) continue;
    const inner = flatten(root, resolved.node, resolved.trail);
    Object.assign(properties, asMap(inner.properties) ?? {});
    for (const name of names(inner.required)) required.add(name);
    type ??= inner.type;
    description ||= text(inner.description);
  }
  const merged: JsonMap = { ...node, properties, required: [...required] };
  delete merged.allOf;
  if (type !== undefined) merged.type = type;
  if (description) merged.description = description;
  return merged;
}

function compact(root: JsonMap, value: unknown, depth: number, trail: Trail): JsonMap {
  const resolved = deref(root, value, trail);
  if (!resolved.node) return {};
  const node = flatten(root, resolved.node, resolved.trail);
  const variant = !node.type && !node.properties ? [node.oneOf, node.anyOf].find(Array.isArray)?.[0] : undefined;
  const out: JsonMap = variant === undefined ? {} : compact(root, variant, depth, resolved.trail);
  for (const key of KEPT_KEYS) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  const description = text(node.description) || text(node.title);
  if (description) out.description = clip(description, MAX_FIELD_TEXT);
  if (Array.isArray(node.enum)) out.enum = node.enum.slice(0, MAX_ENUM);
  const properties = asMap(node.properties);
  if (properties) {
    out.type ??= "object";
    if (depth > 0) {
      const kept: JsonMap = {};
      for (const [name, property] of Object.entries(properties)) {
        const field = deref(root, property, resolved.trail).node;
        if (field?.readOnly === true) continue;
        kept[name] = compact(root, property, depth - 1, resolved.trail);
      }
      out.properties = kept;
      const required = names(node.required).filter((name) => name in kept);
      if (required.length) out.required = required;
    }
  }
  if (node.items !== undefined && depth > 0) out.items = compact(root, node.items, depth - 1, resolved.trail);
  return out;
}

function parametersOf(root: JsonMap, pathItem: JsonMap, operation: JsonMap): JsonMap[] {
  const merged = new Map<string, JsonMap>();
  for (const list of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const parameter = deref(root, item, new Set()).node;
      if (!parameter || !text(parameter.name) || !text(parameter.in)) continue;
      merged.set(`${text(parameter.in)}:${text(parameter.name)}`, parameter);
    }
  }
  return [...merged.values()];
}

function bodyOf(root: JsonMap, operation: JsonMap, parameters: JsonMap[]): { schema: unknown; required: boolean } | null {
  const requestBody = deref(root, operation.requestBody, new Set()).node;
  const content = asMap(requestBody?.content);
  if (content) {
    const type = Object.keys(content).find((key) => /json/i.test(key)) ?? (content["*/*"] ? "*/*" : undefined);
    const media = type ? asMap(content[type]) : null;
    return media?.schema ? { schema: media.schema, required: requestBody?.required === true } : null;
  }
  const legacy = parameters.find((parameter) => parameter.in === "body");
  return legacy?.schema ? { schema: legacy.schema, required: legacy.required === true } : null;
}

function inputOf(
  root: JsonMap,
  path: string,
  parameters: JsonMap[],
  body: { schema: unknown; required: boolean } | null,
  depth: number,
): { inputSchema: JsonMap; query: string[] } {
  const properties: JsonMap = {};
  const required = new Set<string>();
  const query: string[] = [];
  for (const parameter of parameters) {
    const place = text(parameter.in);
    if (place !== "path" && place !== "query") continue;
    const name = place === "path" ? cleanParamName(text(parameter.name)) : text(parameter.name);
    if (!PROPERTY_NAME.test(name) || name in properties) continue;
    const field = compact(root, parameter.schema ?? parameter, depth, new Set());
    const description = text(parameter.description);
    properties[name] = description ? { ...field, description: clip(description, MAX_FIELD_TEXT) } : field;
    if (place === "query") query.push(name);
    if (place === "path" || parameter.required === true) required.add(name);
  }
  for (const match of path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
    const name = match[1]!;
    if (!(name in properties)) properties[name] = { type: "string" };
    required.add(name);
  }
  const fields = body ? compact(root, body.schema, depth + 1, new Set()) : {};
  const bodyProperties = asMap(fields.properties) ?? {};
  const bodyRequired = new Set(names(fields.required));
  for (const [name, field] of Object.entries(bodyProperties)) {
    if (!PROPERTY_NAME.test(name) || name in properties) continue;
    properties[name] = field;
    if (body?.required && bodyRequired.has(name)) required.add(name);
  }
  const inputSchema: JsonMap = { type: "object", properties };
  if (required.size) inputSchema.required = [...required];
  return { inputSchema, query: query.slice(0, 50) };
}

function actionOf(method: HostedTool["method"], operationId: string, summary: string): McpToolAction {
  if (classifySideEffect(method, operationId, summary) === "destructive") return "delete";
  return method === "GET" ? "read" : "write";
}

function toolOf(root: JsonMap, rawPath: string, verb: (typeof METHODS)[number], pathItem: JsonMap, operation: JsonMap): HostedTool | null {
  const method = verb.toUpperCase() as HostedTool["method"];
  const path = rawPath.trim().replace(/\{([^{}]*)\}/g, (_match, inner: string) => `{${cleanParamName(inner)}}`);
  const operationId = text(operation.operationId);
  const summary = text(operation.summary);
  const detail = text(operation.description);
  const parameters = parametersOf(root, pathItem, operation);
  const body = method === "GET" || method === "DELETE" ? null : bodyOf(root, operation, parameters);
  for (const depth of SCHEMA_DEPTHS) {
    const { inputSchema, query } = inputOf(root, path, parameters, body, depth);
    if (JSON.stringify(inputSchema).length > MAX_SCHEMA_CHARS) continue;
    const parsed = hostedToolSchema.safeParse({
      name: cleanToolName(operationId || `${verb}_${path}`),
      title: clip(summary || `${method} ${path}`, 200),
      description: clip(detail || summary, 2000),
      action: actionOf(method, operationId, summary),
      method,
      path,
      query,
      inputSchema,
    });
    return parsed.success ? parsed.data : null;
  }
  return null;
}

function baseUrlOf(root: JsonMap): string {
  const server = asMap(Array.isArray(root.servers) ? root.servers[0] : null);
  if (server) {
    const variables = asMap(server.variables) ?? {};
    return text(server.url)
      .replace(/\{([^{}]+)\}/g, (match, name: string) => text(asMap(variables[name])?.default) || match)
      .replace(/\/+$/, "");
  }
  const host = text(root.host);
  if (!host) return "";
  const schemes = names(root.schemes);
  const scheme = schemes.includes("https") ? "https" : schemes[0] || "https";
  return `${scheme}://${host}${text(root.basePath)}`.replace(/\/+$/, "");
}

function authOf(root: JsonMap): Pick<McpDraftServer, "authType" | "authHeader"> {
  const schemes = asMap(asMap(root.components)?.securitySchemes) ?? asMap(root.securityDefinitions) ?? {};
  const preferred = Array.isArray(root.security) ? root.security.flatMap((entry) => Object.keys(asMap(entry) ?? {})) : [];
  for (const key of [...new Set([...preferred, ...Object.keys(schemes)])]) {
    const scheme = deref(root, schemes[key], new Set()).node;
    if (!scheme) continue;
    const type = text(scheme.type).toLowerCase();
    const http = text(scheme.scheme).toLowerCase();
    const header = text(scheme.name);
    if (type === "oauth2" || type === "openidconnect" || (type === "http" && http === "bearer")) {
      return { authType: "bearer", authHeader: "" };
    }
    if (type === "apikey" && text(scheme.in) === "header" && /^[A-Za-z0-9-]{1,64}$/.test(header)) {
      return { authType: "header", authHeader: header };
    }
    if (type === "basic" || (type === "http" && http === "basic")) return { authType: "header", authHeader: "Authorization" };
  }
  return { authType: "none", authHeader: "" };
}

function isInternal(baseUrl: string): boolean {
  const match = /^(https?):\/\/([^/:]+|\[[^\]]+\])/i.exec(baseUrl);
  if (!match) return false;
  return match[1]!.toLowerCase() === "http" || PRIVATE_HOST.test(match[2]!);
}

export function importOpenApi(root: JsonMap): McpOpenApiImport {
  const info = asMap(root.info) ?? {};
  const baseUrl = baseUrlOf(root);
  const server: McpDraftServer = {
    name: clip(text(info.title) || "API", 48),
    description: clip(text(info.description).split(/\n\s*\n/)[0] ?? "", 500),
    baseUrl: clip(baseUrl, 2048),
    internal: isInternal(baseUrl),
    ...authOf(root),
    notes: "",
  };
  const tools: HostedTool[] = [];
  let operations = 0;
  for (const [path, value] of Object.entries(asMap(root.paths) ?? {})) {
    const pathItem = asMap(value);
    if (!pathItem) continue;
    for (const verb of METHODS) {
      const operation = asMap(pathItem[verb]);
      if (!operation) continue;
      operations += 1;
      if (operations > MAX_OPERATIONS) continue;
      const tool = toolOf(root, path, verb, pathItem, operation);
      if (tool) tools.push(tool);
    }
  }
  return { server, tools: mergeTools([], tools, MAX_OPERATIONS), operations };
}
