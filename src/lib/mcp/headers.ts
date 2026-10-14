import type { JsonMap } from "@/types/gateway";
import type { McpChallenge, McpHeaderParam } from "@/types/mcp";

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRIMITIVE_TYPES = new Set(["string", "integer", "boolean"]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const VALUE_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
const MAX_DEPTH = 64;
const PLAIN_VALUE = /^[\x20-\x7E\t]*$/;
const EDGE_SPACE = /^[ \t]|[ \t]$/;
const AUTH_PARAM = /([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,"]*))?/g;

function asMap(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : null;
}

export function headerParams(schema: JsonMap): McpHeaderParam[] | null {
  const found: McpHeaderParam[] = [];
  const names = new Set<string>();
  let valid = true;
  const visit = (node: unknown, path: string[] | null, depth: number) => {
    if (!valid || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, null, depth + 1);
      return;
    }
    const map = asMap(node);
    if (!map) return;
    if (Object.hasOwn(map, "x-mcp-header")) {
      const header = map["x-mcp-header"];
      const usable =
        path !== null &&
        path.length > 0 &&
        typeof header === "string" &&
        TOKEN.test(header) &&
        typeof map.type === "string" &&
        PRIMITIVE_TYPES.has(map.type) &&
        !names.has(header.toLowerCase());
      if (!usable) {
        valid = false;
        return;
      }
      names.add(header.toLowerCase());
      found.push({ path, header });
    }
    for (const [key, value] of Object.entries(map)) {
      if (key === "x-mcp-header" || VALUE_KEYWORDS.has(key)) continue;
      const children = SCHEMA_MAPS.has(key) ? asMap(value) : null;
      if (!children) {
        visit(value, null, depth + 1);
        continue;
      }
      for (const [child, sub] of Object.entries(children)) {
        visit(sub, key === "properties" && path ? [...path, child] : null, depth + 1);
      }
    }
  };
  visit(schema, [], 0);
  return valid ? found : null;
}

export function headerValue(value: string): string {
  const sentinel = value.startsWith("=?base64?") && value.endsWith("?=");
  if (PLAIN_VALUE.test(value) && !EDGE_SPACE.test(value) && !sentinel) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function paramText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

export function paramHeaders(params: McpHeaderParam[], args: JsonMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of params) {
    let node: unknown = args;
    for (const key of param.path) {
      const map = asMap(node);
      node = map && Object.hasOwn(map, key) ? map[key] : undefined;
    }
    const text = paramText(node);
    if (text !== null) out[`Mcp-Param-${param.header}`] = headerValue(text);
  }
  return out;
}

function unquote(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
}

export function bearerChallenge(header: string | null): McpChallenge | null {
  if (!header) return null;
  const params: Record<string, string> = {};
  let inBearer = false;
  let found = false;
  for (const match of header.matchAll(AUTH_PARAM)) {
    const name = match[1]!;
    const raw = match[2];
    if (raw === undefined) {
      inBearer = name.toLowerCase() === "bearer";
      found ||= inBearer;
      continue;
    }
    const key = name.toLowerCase();
    if (inBearer && !Object.hasOwn(params, key)) params[key] = unquote(raw);
  }
  if (!found) return null;
  return {
    resourceMetadata: params.resource_metadata ?? "",
    scope: params.scope ?? "",
    error: params.error ?? "",
  };
}
