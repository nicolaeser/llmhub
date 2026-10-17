import { createHash } from "node:crypto";
import { asRecord } from "@/lib/gateway/core";
import { relaySse } from "@/lib/gateway/protocols/sse";
import { readJsonOr } from "@/lib/utils/json";
import type { JsonMap } from "@/types/gateway";
import type { ClientTools, ToolNamespace, ToolNamespaces } from "@/types/responses";

const HOSTED_SEARCH_TOOLS = new Set(["web_search", "web_search_preview"]);
const ADDITIONAL_TOOLS = "additional_tools";
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_NAME_LIMIT = 64;

export function namespacedToolName(namespace: string, name: string): string {
  const prefix = namespace.endsWith("__") ? namespace : `${namespace}__`;
  const joined = name.startsWith(prefix) ? name : `${prefix}${name}`;
  if (TOOL_NAME.test(joined)) return joined;
  const hash = createHash("sha256").update(`${namespace}\u0000${name}`).digest("hex").slice(0, 8);
  return `${joined.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, TOOL_NAME_LIMIT - 9)}_${hash}`;
}

function flatTools(tool: unknown, namespaces: Map<string, ToolNamespace>): unknown[] {
  const rec = asRecord(tool);
  if (rec && HOSTED_SEARCH_TOOLS.has(String(rec.type))) return [];
  if (rec?.type !== "namespace" || typeof rec.name !== "string") return [tool];
  const namespace = rec.name;
  return (Array.isArray(rec.tools) ? rec.tools : []).map((child) => {
    const fn = asRecord(child);
    if (fn?.type !== "function" || typeof fn.name !== "string") return child;
    const name = namespacedToolName(namespace, fn.name);
    namespaces.set(name, { namespace, name: fn.name });
    return { ...fn, name };
  });
}

function uniqueTools(tools: unknown[]): unknown[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    const rec = asRecord(tool);
    if (rec?.type !== "function" || typeof rec.name !== "string") return true;
    if (seen.has(rec.name)) return false;
    seen.add(rec.name);
    return true;
  });
}

function qualified(value: unknown, type: string): unknown {
  const rec = asRecord(value);
  if (rec?.type !== type || typeof rec.namespace !== "string" || typeof rec.name !== "string") return value;
  const next: JsonMap = { ...rec, name: namespacedToolName(rec.namespace, rec.name) };
  delete next.namespace;
  return next;
}

export function clientTools(body: JsonMap): ClientTools {
  const namespaces = new Map<string, ToolNamespace>();
  const input = Array.isArray(body.input) ? body.input : null;
  const extra = (input ?? []).flatMap((item) => {
    const rec = asRecord(item);
    return rec?.type === ADDITIONAL_TOOLS && Array.isArray(rec.tools) ? rec.tools : [];
  });
  const offered = [...(Array.isArray(body.tools) ? body.tools : []), ...extra];
  const tools = uniqueTools(offered.flatMap((tool) => flatTools(tool, namespaces)));
  const next: JsonMap = { ...body };
  if (input) {
    next.input = input
      .filter((item) => asRecord(item)?.type !== ADDITIONAL_TOOLS)
      .map((item) => qualified(item, "function_call"));
  }
  if (tools.length || Array.isArray(body.tools)) next.tools = tools;
  if (body.tool_choice !== undefined) next.tool_choice = qualified(body.tool_choice, "function");
  return { body: next, namespaces };
}

function localCall(item: unknown, namespaces: ToolNamespaces): unknown {
  const rec = asRecord(item);
  const origin = rec?.type === "function_call" && typeof rec.name === "string" ? namespaces.get(rec.name) : undefined;
  return origin ? { ...rec, name: origin.name, namespace: origin.namespace } : item;
}

function localOutput(response: JsonMap, namespaces: ToolNamespaces): JsonMap {
  if (!Array.isArray(response.output)) return response;
  return { ...response, output: response.output.map((item) => localCall(item, namespaces)) };
}

export function localToolNames(payload: JsonMap, namespaces: ToolNamespaces): JsonMap {
  if (!namespaces.size) return payload;
  let next = localOutput(payload, namespaces);
  if (payload.item !== undefined) next = { ...next, item: localCall(payload.item, namespaces) };
  const response = asRecord(payload.response);
  if (response) next = { ...next, response: localOutput(response, namespaces) };
  const origin =
    payload.type === "response.function_call_arguments.done" && typeof payload.name === "string"
      ? namespaces.get(payload.name)
      : undefined;
  if (origin) next = { ...next, name: origin.name, namespace: origin.namespace };
  return next;
}

export async function withToolNamespaces(response: Response, namespaces: ToolNamespaces): Promise<Response> {
  if (!namespaces.size || !response.ok || !response.body) return response;
  const type = response.headers.get("content-type") ?? "";
  const init = { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) };
  if (type.includes("text/event-stream")) {
    const relayed = relaySse(response, { map: (json) => localToolNames(json, namespaces) });
    return new Response(relayed.body, init);
  }
  if (!type.includes("application/json")) return response;
  const json = asRecord(await readJsonOr(response, null));
  init.headers.delete("content-length");
  return new Response(JSON.stringify(json ? localToolNames(json, namespaces) : json), init);
}
