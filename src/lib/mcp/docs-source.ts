import { cancelQuietly } from "@/lib/utils/streams";
import type { McpDocsAuth, McpFetch, McpLinkedDocument } from "@/types/mcp";

export const MAX_LINKED_DOCS_BYTES = 8_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NO_AUTH: McpDocsAuth = { type: "none", name: "", secret: "" };
const SKIPPED_TAGS = new Set(["script", "style", "noscript", "svg", "head", "template", "iframe"]);
const BREAK_TAGS = new Set([
  "br",
  "p",
  "div",
  "li",
  "tr",
  "pre",
  "section",
  "article",
  "table",
  "ul",
  "ol",
  "dt",
  "dd",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const ENTITIES: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

export function docsLink(docs: string): string | null {
  const value = docs.trim();
  if (!/^https?:\/\/\S+$/i.test(value) || !URL.canParse(value)) return null;
  return value;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Math.min(Number.parseInt(lower.slice(2), 16), 0x10ffff));
    if (lower.startsWith("#")) return String.fromCodePoint(Math.min(Number.parseInt(lower.slice(1), 10), 0x10ffff));
    return ENTITIES[lower] ?? match;
  });
}

export function htmlText(html: string): string {
  let out = "";
  let skipping = "";
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    const chunk = open < 0 ? html.slice(at) : html.slice(at, open);
    if (!skipping) out += chunk;
    if (open < 0) break;
    const close = html.indexOf(">", open);
    if (close < 0) break;
    const tag = html.slice(open, close + 1);
    const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
    const name = match?.[2]?.toLowerCase() ?? "";
    const closing = match?.[1] === "/";
    if (skipping) {
      if (closing && name === skipping) skipping = "";
    } else if (!closing && SKIPPED_TAGS.has(name) && !tag.endsWith("/>")) {
      skipping = name;
    } else {
      out += BREAK_TAGS.has(name) ? "\n" : " ";
    }
    at = close + 1;
  }
  return decodeEntities(out)
    .replace(/[ \t\f\r\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readUpTo(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value.byteLength;
    if (size > limit) {
      await cancelQuietly(reader);
      throw new Error("MCP_BUILDER_FETCH_SIZE");
    }
    chunks.push(step.value);
  }
  return Buffer.concat(chunks);
}

function sameSite(start: URL, target: URL): boolean {
  if (target.origin === start.origin) return true;
  return start.protocol === "http:" && target.protocol === "https:" && target.hostname === start.hostname;
}

function authorizedRequest(target: URL, auth: McpDocsAuth): { url: string; headers: Record<string, string> } {
  const url = new URL(target);
  url.hash = "";
  const headers: Record<string, string> = {
    Accept: "application/json, application/yaml, text/yaml, text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.5",
    "User-Agent": "llmhub-mcp-anything",
  };
  if (auth.type === "bearer") headers.Authorization = `Bearer ${auth.secret}`;
  if (auth.type === "basic") headers.Authorization = `Basic ${Buffer.from(`${auth.name}:${auth.secret}`, "utf8").toString("base64")}`;
  if (auth.type === "header") {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === auth.name.toLowerCase()) delete headers[key];
    headers[auth.name] = auth.secret;
  }
  if (auth.type === "query") url.searchParams.set(auth.name, auth.secret);
  return { url: url.toString(), headers };
}

export async function fetchDocs(link: string, fetchImpl: McpFetch, auth: McpDocsAuth = NO_AUTH): Promise<McpLinkedDocument> {
  const start = new URL(link);
  let target = new URL(link);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const trusted = sameSite(start, target);
    if (!trusted && auth.type === "query" && target.searchParams.get(auth.name) === auth.secret) target.searchParams.delete(auth.name);
    const request = authorizedRequest(target, trusted ? auth : NO_AUTH);
    const response = await fetchImpl(request.url, {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (REDIRECTS.has(response.status)) {
      await cancelQuietly(response.body);
      const location = response.headers.get("location");
      if (!location || !URL.canParse(location, target)) throw new Error("MCP_BUILDER_FETCH");
      target = new URL(location, target);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      await cancelQuietly(response.body);
      throw new Error("MCP_BUILDER_FETCH_AUTH");
    }
    if (!response.ok) {
      await cancelQuietly(response.body);
      throw new Error("MCP_BUILDER_FETCH");
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_LINKED_DOCS_BYTES) {
      await cancelQuietly(response.body);
      throw new Error("MCP_BUILDER_FETCH_SIZE");
    }
    const bytes = await readUpTo(response, MAX_LINKED_DOCS_BYTES);
    const url = new URL(target);
    url.search = "";
    url.hash = "";
    return { url: url.toString(), contentType: response.headers.get("content-type") ?? "", bytes };
  }
  throw new Error("MCP_BUILDER_FETCH");
}

export function linkedText(doc: McpLinkedDocument): string {
  const text = Buffer.from(doc.bytes).toString("utf8");
  const html = /html/i.test(doc.contentType) || /^\s*<(?:!doctype\s+html|html)\b/i.test(text);
  return html ? htmlText(text) : text;
}
