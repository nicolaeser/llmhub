import { sameSite } from "@/lib/mcp/docs-login";
import { cancelQuietly } from "@/lib/utils/streams";
import type {
  McpDocsAuth,
  McpDocsCookie,
  McpDocsJar,
  McpDocsResponse,
  McpDocsSession,
  McpFetch,
  McpLinkedDocument,
} from "@/types/mcp";

export const MAX_LINKED_DOCS_BYTES = 8_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const MAX_COOKIES = 50;
const MAX_COOKIE_BYTES = 4096;
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
const HTML_START = /^\s*<(?:!doctype\s+html|html)\b/i;

export function docsLink(docs: string): string | null {
  const value = docs.trim();
  if (!/^https?:\/\/\S+$/i.test(value) || !URL.canParse(value)) return null;
  return value;
}

export function decodeEntities(text: string): string {
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

export function isHtml(contentType: string, text: string): boolean {
  return /html/i.test(contentType) || HTML_START.test(text);
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

function sendsCookieHeader(auth: McpDocsAuth): boolean {
  return auth.type === "cookie" || (auth.type === "header" && auth.name.toLowerCase() === "cookie");
}

function keepCookie(jar: McpDocsJar, cookie: McpDocsCookie): void {
  const key = `${cookie.path}\n${cookie.name}`;
  if (!jar.has(key) && jar.size >= MAX_COOKIES) return;
  jar.set(key, cookie);
}

export function docsJar(auth: McpDocsAuth): McpDocsJar {
  const jar: McpDocsJar = new Map();
  if (!sendsCookieHeader(auth)) return jar;
  for (const part of auth.secret.split(";")) {
    const eq = part.indexOf("=");
    const name = eq > 0 ? part.slice(0, eq).trim() : "";
    if (name) keepCookie(jar, { name, value: part.slice(eq + 1).trim(), path: "/", secure: false });
  }
  return jar;
}

export function docsSession(link: string, fetchImpl: McpFetch, auth: McpDocsAuth = NO_AUTH): McpDocsSession {
  return { start: new URL(link), fetchImpl, auth, jar: docsJar(auth) };
}

function defaultCookiePath(url: URL): string {
  const slash = url.pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : url.pathname.slice(0, slash);
}

function cookiePathMatches(path: string, cookiePath: string): boolean {
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || path[cookiePath.length] === "/";
}

function setCookieLines(headers: Headers): string[] {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function rememberCookies(jar: McpDocsJar, headers: Headers, url: URL): void {
  const host = url.hostname.toLowerCase();
  for (const line of setCookieLines(headers)) {
    if (line.length > MAX_COOKIE_BYTES) continue;
    const [pair = "", ...attributes] = line.split(";");
    const eq = pair.indexOf("=");
    const name = eq > 0 ? pair.slice(0, eq).trim() : "";
    if (!name) continue;
    let path = defaultCookiePath(url);
    let secure = false;
    let maxAge: number | null = null;
    let expires: number | null = null;
    let foreign = false;
    for (const attribute of attributes) {
      const at = attribute.indexOf("=");
      const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
      const value = at < 0 ? "" : attribute.slice(at + 1).trim();
      if (key === "path" && value.startsWith("/")) path = value;
      else if (key === "secure") secure = true;
      else if (key === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value);
      else if (key === "expires" && Number.isFinite(Date.parse(value))) expires = Date.parse(value);
      else if (key === "domain") {
        const domain = value.replace(/^\./, "").toLowerCase();
        if (domain && host !== domain && !host.endsWith(`.${domain}`)) foreign = true;
      }
    }
    if (foreign) continue;
    const expired = maxAge !== null ? maxAge <= 0 : expires !== null && expires <= Date.now();
    if (expired) jar.delete(`${path}\n${name}`);
    else keepCookie(jar, { name, value: pair.slice(eq + 1).trim(), path, secure });
  }
}

function cookieHeader(jar: McpDocsJar, url: URL): string {
  return [...jar.values()]
    .filter((cookie) => cookiePathMatches(url.pathname, cookie.path) && (!cookie.secure || url.protocol === "https:"))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function authorizedRequest(target: URL, auth: McpDocsAuth, cookies: string): { url: string; headers: Record<string, string> } {
  const url = new URL(target);
  url.hash = "";
  const headers: Record<string, string> = {
    Accept: "application/json, application/yaml, text/yaml, text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.5",
    "User-Agent": "llmhub-mcp-anything",
  };
  if (auth.type === "bearer") headers.Authorization = `Bearer ${auth.secret}`;
  if (auth.type === "basic") headers.Authorization = `Basic ${Buffer.from(`${auth.name}:${auth.secret}`, "utf8").toString("base64")}`;
  if (auth.type === "header" && !sendsCookieHeader(auth)) {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === auth.name.toLowerCase()) delete headers[key];
    headers[auth.name] = auth.secret;
  }
  if (auth.type === "query") url.searchParams.set(auth.name, auth.secret);
  if (cookies) headers.Cookie = cookies;
  return { url: url.toString(), headers };
}

export function docsPageUrl(target: URL, auth: McpDocsAuth): URL {
  const url = new URL(target);
  url.hash = "";
  if (auth.type === "query" && auth.name) url.searchParams.delete(auth.name);
  return url;
}

export async function loadDocsPage(
  session: McpDocsSession,
  target: URL,
  limit = MAX_LINKED_DOCS_BYTES,
  follows: (url: URL) => boolean = () => true,
): Promise<McpDocsResponse> {
  const { start, auth, jar } = session;
  let current = new URL(target);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const trusted = sameSite(start, current);
    if (!trusted && auth.type === "query" && current.searchParams.get(auth.name) === auth.secret) current.searchParams.delete(auth.name);
    const request = trusted ? authorizedRequest(current, auth, cookieHeader(jar, current)) : authorizedRequest(current, NO_AUTH, "");
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await session.fetchImpl(request.url, {
      method: "GET",
      headers: request.headers,
      signal: session.signal ? AbortSignal.any([timeout, session.signal]) : timeout,
    });
    if (trusted) rememberCookies(jar, response.headers, current);
    if (REDIRECTS.has(response.status)) {
      await cancelQuietly(response.body);
      const location = response.headers.get("location");
      if (!location || !URL.canParse(location, current)) throw new Error("MCP_BUILDER_FETCH");
      current = new URL(location, current);
      if (!follows(current)) throw new Error("MCP_BUILDER_FETCH_SKIPPED");
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
    if (Number.isFinite(declared) && declared > limit) {
      await cancelQuietly(response.body);
      throw new Error("MCP_BUILDER_FETCH_SIZE");
    }
    const bytes = await readUpTo(response, limit);
    return {
      url: docsPageUrl(current, auth),
      requested: docsPageUrl(target, auth),
      redirected: hop > 0,
      contentType: response.headers.get("content-type") ?? "",
      bytes,
    };
  }
  throw new Error("MCP_BUILDER_FETCH");
}

export async function fetchDocs(link: string, fetchImpl: McpFetch, auth: McpDocsAuth = NO_AUTH): Promise<McpLinkedDocument> {
  const session = docsSession(link, fetchImpl, auth);
  const page = await loadDocsPage(session, session.start);
  const url = new URL(page.url);
  url.search = "";
  return { url: url.toString(), contentType: page.contentType, bytes: page.bytes };
}

export function linkedText(doc: Pick<McpLinkedDocument, "contentType" | "bytes">): string {
  const text = Buffer.from(doc.bytes).toString("utf8");
  return isHtml(doc.contentType, text) ? htmlText(text) : text;
}
