import { parse as parseYaml } from "yaml";
import { classifySideEffect } from "@/lib/integrations/ingest";
import { normalizeBaseUrl, rebaseTools } from "@/lib/mcp/base-url";
import { cleanParamName, cleanToolName, mergeTools } from "@/lib/mcp/hosted";
import { parseJsonOrNull } from "@/lib/utils/json";
import { authNameValid, hostedToolSchema } from "@/schemas/mcp";
import type { JsonMap } from "@/types/gateway";
import type { HostedTool, McpApiAddress, McpDraftServer, McpOpenApiImport, McpToolAction } from "@/types/mcp";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const SCHEMA_DEPTHS = [4, 2, 1, 0] as const;
const MAX_SCHEMA_CHARS = 30_000;
const MAX_OPERATIONS = 1_000;
const MAX_ENUM = 50;
const MAX_FIELD_TEXT = 300;
const MAX_REF_HOPS = 16;
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const KEPT_KEYS = ["format", "default", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "nullable"] as const;
const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const TYPE_ALIASES: Record<string, { type: string; format?: string }> = {
  datetime: { type: "string", format: "date-time" },
  "date-time": { type: "string", format: "date-time" },
  timestamp: { type: "string", format: "date-time" },
  date: { type: "string", format: "date" },
  time: { type: "string", format: "time" },
  text: { type: "string" },
  file: { type: "string" },
  int: { type: "integer" },
  long: { type: "integer" },
  float: { type: "number" },
  double: { type: "number" },
  decimal: { type: "number" },
  bool: { type: "boolean" },
};
const RPC_SEGMENTS = new Set(["do", "function", "functions", "rpc", "call"]);
const ACTION_WORDS = new Set([
  "search", "find", "list", "get", "view", "show", "lookup", "query", "count", "check", "export", "download",
  "create", "add", "new", "insert", "update", "edit", "set", "save", "upsert", "patch", "replace",
  "delete", "remove", "clear", "purge", "archive", "start", "stop", "lock", "unlock", "mark", "upload", "import",
  "send", "close", "open", "cancel", "approve", "reject", "assign", "move", "copy", "merge", "sync", "reset",
]);
const READ_WORDS = new Set(["get", "search", "find", "list", "lookup", "query", "count", "check", "validate", "verify"]);
const LOOKUP_WORD = /^(?:view|get|find|search|show|list)by/;
const MIN_ENTITY_FIELDS = 3;
const MIN_ENVELOPE_SAMPLES = 3;
const PRIVATE_HOST = /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

type Trail = ReadonlySet<string>;

type Body = { schema: unknown; required: boolean };

type Spec = {
  root: JsonMap;
  prefix: string;
  envelope: ReadonlySet<string>;
  entities: ReadonlyMap<string, { schema: unknown; source: string }>;
};

type Draft = { tool: HostedTool; tag: string };

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
  Object.assign(out, typeFields(node.type));
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
  if (out.type === "array" && out.items === undefined) out.items = {};
  return out;
}

function typeFields(value: unknown): JsonMap {
  if (Array.isArray(value)) {
    const kept = value.filter((item): item is string => typeof item === "string" && JSON_TYPES.has(item));
    return kept.length ? { type: kept.length === 1 ? kept[0] : kept } : {};
  }
  if (typeof value !== "string") return {};
  const name = value.trim().toLowerCase();
  if (JSON_TYPES.has(name)) return { type: name };
  const alias = TYPE_ALIASES[name];
  return alias ? { ...alias } : {};
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

function bodyOf(root: JsonMap, operation: JsonMap, parameters: JsonMap[]): Body | null {
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

function refOf(value: unknown): string {
  const node = asMap(value);
  if (!node) return "";
  if (typeof node.$ref === "string") return node.$ref;
  return typeof asMap(node.items)?.$ref === "string" ? String(asMap(node.items)!.$ref) : "";
}

function successSchema(root: JsonMap, operation: JsonMap): unknown {
  const responses = asMap(operation.responses) ?? {};
  const code = Object.keys(responses).find((key) => /^2\d\d$/.test(key)) ?? (responses.default ? "default" : undefined);
  const response = code ? deref(root, responses[code], new Set()).node : null;
  if (!response) return undefined;
  const content = asMap(response.content);
  if (!content) return response.schema;
  const type = Object.keys(content).find((key) => /json/i.test(key)) ?? (content["*/*"] ? "*/*" : undefined);
  return type ? asMap(content[type])?.schema : undefined;
}

function entityOf(root: JsonMap, schema: unknown): JsonMap | null {
  const resolved = deref(root, schema, new Set());
  if (!resolved.node) return null;
  const node = flatten(root, resolved.node, resolved.trail);
  if (asMap(node.properties)) return node;
  const items = deref(root, node.items, resolved.trail).node;
  return items && asMap(items.properties) ? flatten(root, items, resolved.trail) : null;
}

function fieldNames(root: JsonMap, schema: unknown): string[] {
  return Object.keys(asMap(entityOf(root, schema)?.properties) ?? {});
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function isParam(segment: string): boolean {
  return /^\{[^{}]*\}$/.test(segment);
}

function commonPrefix(paths: string[]): string {
  if (paths.length < 2) return "";
  const lists = paths.map(splitPath);
  const shared: string[] = [];
  for (let at = 0; ; at += 1) {
    const segment = lists[0]![at];
    if (!segment || isParam(segment)) break;
    if (!lists.every((list) => list[at] === segment && list.length > at + 1)) break;
    shared.push(segment);
  }
  return shared.length ? `/${shared.join("/")}` : "";
}

function snake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function asciiSlug(value: string): string {
  return snake(value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss"));
}

function resourceOf(path: string, prefix: string): string {
  const first = splitPath(path.slice(prefix.length)).find((segment) => !isParam(segment));
  return first && !RPC_SEGMENTS.has(first.toLowerCase()) ? first.toLowerCase() : "";
}

function isRpc(path: string, prefix: string): boolean {
  return splitPath(path.slice(prefix.length)).some((segment) => RPC_SEGMENTS.has(segment.toLowerCase()));
}

function operationName(verb: (typeof METHODS)[number], path: string, prefix: string): string {
  const kept: string[] = [];
  let byId = false;
  for (const segment of splitPath(path.slice(prefix.length))) {
    if (isParam(segment)) {
      byId = true;
      if (kept.length && snake(kept[kept.length - 1]!) === snake(segment.slice(1, -1))) kept.pop();
      continue;
    }
    if (RPC_SEGMENTS.has(segment.toLowerCase()) || /^\d+$/.test(segment)) continue;
    kept.push(segment);
  }
  const base = kept.map(snake).filter(Boolean).join("_");
  if (!base) return "";
  const named = base.split("_").some((word) => ACTION_WORDS.has(word) || LOOKUP_WORD.test(word));
  if (named || isRpc(path, prefix)) return cleanToolName(base);
  const action = { get: byId ? "get" : "list", post: "create", put: "update", patch: "update", delete: "delete" }[verb];
  return cleanToolName(`${action}_${base}`);
}

function firstSentence(value: string): string {
  const match = /^([\s\S]+?[.!?])(?:\s|$)/.exec(value);
  return (match?.[1] ?? value).trim();
}

function envelopeOf(root: JsonMap, operations: { verb: (typeof METHODS)[number]; operation: JsonMap }[]): Set<string> {
  const samples = operations
    .filter(({ verb }) => verb === "post" || verb === "put" || verb === "patch")
    .map(({ operation }) => fieldNames(root, successSchema(root, operation)))
    .filter((fields) => fields.length > 0);
  if (samples.length < MIN_ENVELOPE_SAMPLES) return new Set();
  return new Set(samples[0]!.filter((name) => samples.every((fields) => fields.includes(name))));
}

function entitiesOf(
  root: JsonMap,
  prefix: string,
  operations: { verb: (typeof METHODS)[number]; path: string; operation: JsonMap }[],
): Map<string, { schema: unknown; source: string }> {
  const entities = new Map<string, { schema: unknown; source: string }>();
  for (const { verb, path, operation } of operations) {
    if (verb !== "get" || splitPath(path).some(isParam) || isRpc(path, prefix)) continue;
    const resource = resourceOf(path, prefix);
    if (!resource || entities.has(resource)) continue;
    const schema = successSchema(root, operation);
    if (fieldNames(root, schema).length >= MIN_ENTITY_FIELDS) entities.set(resource, { schema, source: path });
  }
  return entities;
}

function bodyFields(
  spec: Spec,
  verb: (typeof METHODS)[number],
  path: string,
  operation: JsonMap,
  body: Body,
  depth: number,
  taken: ReadonlySet<string>,
): { properties: JsonMap; required: string[]; open: boolean; borrowed: string } {
  const { root } = spec;
  const pathNames = new Set([...path.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!.toLowerCase()));
  const echo = Boolean(refOf(body.schema)) && refOf(body.schema) === refOf(successSchema(root, operation));
  const fields = compact(root, body.schema, depth + 1, new Set());
  const properties: JsonMap = {};
  for (const [name, field] of Object.entries(asMap(fields.properties) ?? {})) {
    if (!PROPERTY_NAME.test(name) || taken.has(name)) continue;
    if (echo && (spec.envelope.has(name) || pathNames.has(name.toLowerCase()))) continue;
    properties[name] = field;
  }
  const required = body.required && !echo ? names(fields.required).filter((name) => name in properties) : [];
  if (Object.keys(properties).length || (fields.type && fields.type !== "object")) {
    return { properties, required, open: false, borrowed: "" };
  }
  const entity = isRpc(path, spec.prefix) ? undefined : spec.entities.get(resourceOf(path, spec.prefix));
  if (entity) {
    const borrowed = compact(root, entity.schema, depth + 1, new Set());
    const source = asMap(borrowed.properties) ?? asMap(asMap(borrowed.items)?.properties) ?? {};
    for (const [name, field] of Object.entries(source)) {
      if (!PROPERTY_NAME.test(name) || taken.has(name) || spec.envelope.has(name)) continue;
      if (pathNames.has(name.toLowerCase()) || (verb === "post" && name.toLowerCase() === "id")) continue;
      properties[name] = field;
    }
  }
  return { properties, required: [], open: true, borrowed: entity && Object.keys(properties).length ? entity.source : "" };
}

function inputOf(
  spec: Spec,
  verb: (typeof METHODS)[number],
  path: string,
  operation: JsonMap,
  parameters: JsonMap[],
  body: Body | null,
  depth: number,
): { inputSchema: JsonMap; query: string[]; open: boolean; borrowed: string } {
  const { root } = spec;
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
  const fields = body
    ? bodyFields(spec, verb, path, operation, body, depth, new Set(Object.keys(properties)))
    : { properties: {}, required: [], open: false, borrowed: "" };
  Object.assign(properties, fields.properties);
  for (const name of fields.required) required.add(name);
  const inputSchema: JsonMap = { type: "object", properties };
  if (required.size) inputSchema.required = [...required];
  if (fields.open) inputSchema.additionalProperties = true;
  return { inputSchema, query: query.slice(0, 50), open: fields.open, borrowed: fields.borrowed };
}

function openNote(borrowed: string): string {
  return borrowed
    ? ` The API documentation does not list the request fields; the fields shown are those of the records returned by GET ${borrowed}, and other fields the API accepts may be passed too.`
    : " The API documentation does not list the request fields; pass the fields the API expects.";
}

function actionOf(method: HostedTool["method"], operationId: string, summary: string): McpToolAction {
  if (classifySideEffect(method, operationId, summary) === "destructive") return "delete";
  if (method === "POST" && READ_WORDS.has(snake(operationId).split("_")[0] ?? "")) return "read";
  return method === "GET" ? "read" : "write";
}

function toolOf(spec: Spec, rawPath: string, verb: (typeof METHODS)[number], pathItem: JsonMap, operation: JsonMap): Draft | null {
  const { root } = spec;
  const method = verb.toUpperCase() as HostedTool["method"];
  const path = rawPath.trim().replace(/\{([^{}]*)\}/g, (_match, inner: string) => `{${cleanParamName(inner)}}`);
  const operationId = text(operation.operationId);
  const summary = text(operation.summary);
  const detail = text(operation.description);
  const tag = names(operation.tags)[0]?.trim() ?? "";
  const parameters = parametersOf(root, pathItem, operation);
  const body = method === "GET" || method === "DELETE" ? null : bodyOf(root, operation, parameters);
  const name = cleanToolName(operationId || operationName(verb, path, spec.prefix) || `${verb}_${path}`);
  const title = summary ? firstSentence(summary) : tag ? `${tag}: ${method} ${path}` : `${method} ${path}`;
  for (const depth of SCHEMA_DEPTHS) {
    const { inputSchema, query, open, borrowed } = inputOf(spec, verb, path, operation, parameters, body, depth);
    if (JSON.stringify(inputSchema).length > MAX_SCHEMA_CHARS) continue;
    const described = detail || summary || title;
    const parsed = hostedToolSchema.safeParse({
      name,
      title: clip(title, 200),
      description: clip(open ? `${clip(described, 1500)}${openNote(borrowed)}` : described, 2000),
      action: actionOf(method, operationId || name, summary),
      method,
      path,
      query,
      inputSchema,
    });
    return parsed.success ? { tool: parsed.data, tag } : null;
  }
  return null;
}

function distinctNames(drafts: Draft[]): HostedTool[] {
  const counts = new Map<string, number>();
  for (const { tool } of drafts) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return drafts.map(({ tool, tag }) => {
    const slug = asciiSlug(tag);
    if ((counts.get(tool.name) ?? 0) < 2 || !slug || tool.name.endsWith(`_${slug}`)) return tool;
    return { ...tool, name: cleanToolName(`${tool.name.slice(0, 63 - slug.length)}_${slug}`) };
  });
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
    if (type === "apikey" && text(scheme.in) === "header" && authNameValid("header", header)) {
      return { authType: "header", authHeader: header };
    }
    if (type === "apikey" && text(scheme.in) === "query" && authNameValid("query", header)) {
      return { authType: "query", authHeader: header };
    }
    if (type === "basic" || (type === "http" && http === "basic")) return { authType: "basic", authHeader: "" };
  }
  return { authType: "none", authHeader: "" };
}

function isInternal(baseUrl: string): boolean {
  const match = /^(https?):\/\/([^/:]+|\[[^\]]+\])/i.exec(baseUrl);
  if (!match) return false;
  return match[1]!.toLowerCase() === "http" || PRIVATE_HOST.test(match[2]!);
}

function resolvedBase(baseUrl: string, documentUrl: string): string {
  const relative = !baseUrl || baseUrl.startsWith("/") || baseUrl.startsWith(".");
  if (!documentUrl || !relative || !URL.canParse(baseUrl || "/", documentUrl)) return baseUrl;
  const url = new URL(baseUrl || "/", documentUrl);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function absolute(baseUrl: string): boolean {
  return /^https?:\/\/[^/]/i.test(baseUrl);
}

function chosenBase(declared: string, documentUrl: string, address: McpApiAddress): string {
  const given = normalizeBaseUrl(address.given ?? "");
  if (absolute(given)) return given;
  if (absolute(declared)) return declared;
  const hinted = normalizeBaseUrl(address.hinted ?? "");
  if (absolute(hinted)) return declared ? resolvedBase(declared, `${hinted}/`) : hinted;
  return resolvedBase(declared, documentUrl);
}

export function importOpenApi(root: JsonMap, documentUrl = "", address: McpApiAddress = {}): McpOpenApiImport {
  const info = asMap(root.info) ?? {};
  const baseUrl = chosenBase(baseUrlOf(root), documentUrl, address);
  const operations: { verb: (typeof METHODS)[number]; path: string; pathItem: JsonMap; operation: JsonMap }[] = [];
  for (const [path, value] of Object.entries(asMap(root.paths) ?? {})) {
    const pathItem = asMap(value);
    if (!pathItem) continue;
    for (const verb of METHODS) {
      const operation = asMap(pathItem[verb]);
      if (operation) operations.push({ verb, path: path.trim(), pathItem, operation });
    }
  }
  const handled = operations.slice(0, MAX_OPERATIONS);
  const prefix = commonPrefix(handled.map((entry) => entry.path));
  const spec: Spec = { root, prefix, envelope: envelopeOf(root, handled), entities: entitiesOf(root, prefix, handled) };
  const drafts = handled.flatMap(({ verb, path, pathItem, operation }) => toolOf(spec, path, verb, pathItem, operation) ?? []);
  const server: McpDraftServer = {
    name: clip(text(info.title) || "API", 48),
    description: clip(text(info.description).split(/\n\s*\n/)[0] ?? "", 500),
    baseUrl: clip(baseUrl, 2048),
    internal: isInternal(baseUrl),
    ...authOf(root),
    notes: "",
  };
  const tools = rebaseTools(baseUrl, distinctNames(drafts));
  return { server, tools: mergeTools([], tools, MAX_OPERATIONS), operations: operations.length };
}
