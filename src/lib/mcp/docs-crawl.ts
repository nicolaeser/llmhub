import { createHash } from "node:crypto";
import { sameSite } from "@/lib/mcp/docs-login";
import { decodeEntities, docsPageUrl, docsSession, htmlText, isHtml, loadDocsPage } from "@/lib/mcp/docs-source";
import { readApiDocument } from "@/lib/mcp/openapi";
import { MAX_CRAWL_DEPTH } from "@/schemas/mcp";
import type {
  McpCrawlBudget,
  McpCrawlLimit,
  McpDocsAuth,
  McpDocsCrawl,
  McpDocsFetched,
  McpDocsLink,
  McpDocsPage,
  McpDocsResponse,
  McpDocsSession,
  McpDocsSite,
  McpFetch,
} from "@/types/mcp";

export const CRAWL_MAX_PAGES = 300;
export const CRAWL_PAGE_BYTES = 4_000_000;
export const CRAWL_TOTAL_BYTES = 40_000_000;
export const CRAWL_TIME_MS = 120_000;
export const CRAWL_CONCURRENCY = 4;
export const MAX_FETCHED_PAGES = 30;

const MAX_SEEN = 5_000;
const MAX_TITLE = 200;
const FETCH_PAGE_TIMEOUT_MS = 20_000;
const LOGIN_WALL_TEXT = 3_000;
const BOILERPLATE_MIN_PAGES = 3;
const BOILERPLATE_SHARE = 0.5;
const CONTENT_RUN = 3;
const MIN_SECRET_CHARS = 6;

const ASSET_EXTENSIONS = new Set([
  "css", "js", "mjs", "cjs", "map", "wasm",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp", "tif", "tiff",
  "woff", "woff2", "ttf", "otf", "eot",
  "zip", "gz", "tgz", "tar", "rar", "7z", "bz2", "xz", "jar", "war",
  "mp3", "mp4", "m4a", "webm", "ogg", "wav", "avi", "mov", "mkv", "flac",
  "exe", "dmg", "msi", "apk", "iso", "bin", "deb", "rpm",
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "ods", "odp", "epub",
]);
const SESSION_PATH = /log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off|abmelden|ausloggen/i;
const DESTRUCTIVE_SEGMENT = /^(?:delete|remove|destroy)$/i;
const DOCUMENT_SEGMENT = /\.(?:html?|xhtml|md|markdown|txt|rst|adoc)$/i;
const DESTRUCTIVE_QUERY = /delete|remove|destroy|log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off|abmelden|ausloggen/i;
const HIDDEN_BLOCKS = /<!--[\s\S]*?-->|<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const LINK_TAG = /<(a|area|frame|iframe|link|base)\b([^>]*)>/gi;
const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const SPEC_HINT = /["'`]([^"'`\s<>(){}]{2,300})["'`]/g;
const SPEC_FILE = /(?:openapi|swagger|api[-_]?docs?)[^/]*\.(?:json|ya?ml)$/i;
const SPEC_PATH = /(?:^|\/)(?:openapi|swagger|api-docs)(?:\.(?:json|ya?ml))?$/i;
const PASSWORD_FIELD = /<input\b[^>]*\btype\s*=\s*["']?password\b/i;
const LOGIN_PATH = /(?:^|[/_.-])(?:log-?in|sign-?in|sign_in|anmelden|sso|saml|cas|auth|authorize|session|oauth2?)(?:$|[/_.-])/i;
const TEXT_TYPES = /^(?:text\/|application\/(?:json|ld\+json|ya?ml|x-yaml|xml|markdown))/i;

type CrawlItem = { url: URL; depth: number; order: number; spec: boolean };

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

function directoryOf(url: URL): string {
  return url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/";
}

function extensionOf(url: URL): string {
  const last = url.pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

export function crawlBudget(now = Date.now()): McpCrawlBudget {
  return { pages: CRAWL_MAX_PAGES, bytes: CRAWL_TOTAL_BYTES, fetches: MAX_FETCHED_PAGES, deadline: now + CRAWL_TIME_MS };
}

export function specUrl(url: URL): boolean {
  return SPEC_FILE.test(url.pathname) || SPEC_PATH.test(url.pathname);
}

export function skippedUrl(url: URL): "asset" | "session" | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "asset";
  if (ASSET_EXTENSIONS.has(extensionOf(url))) return "asset";
  const path = decoded(url.pathname);
  if (SESSION_PATH.test(path)) return "session";
  const segments = path.split("/").filter(Boolean);
  const action = (segment: string) => !DOCUMENT_SEGMENT.test(segment) && DESTRUCTIVE_SEGMENT.test(segment.replace(/\.[A-Za-z0-9]+$/, ""));
  if (segments.some(action)) return "session";
  if (url.search && DESTRUCTIVE_QUERY.test(decoded(url.search))) return "session";
  return null;
}

export function inCrawlScope(site: Pick<McpDocsSite, "session" | "scopes">, url: URL): boolean {
  if (!sameSite(site.session.start, url)) return false;
  return site.scopes.some((scope) => url.pathname.startsWith(scope) || `${url.pathname}/` === scope);
}

function attributesOf(raw: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (!found.has(name)) found.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim());
  }
  return found;
}

function resolved(value: string, base: URL): URL | null {
  if (!value || /^(?:mailto|javascript|tel|data|sms|ftp|file):/i.test(value) || !URL.canParse(value, base)) return null;
  const url = new URL(value, base);
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

export function pageLinks(html: string, pageUrl: URL): { links: URL[]; specs: URL[] } {
  const visible = html.replace(HIDDEN_BLOCKS, " ");
  const tags = [...visible.matchAll(LINK_TAG)].map((match) => ({ tag: match[1]!.toLowerCase(), attributes: attributesOf(match[2] ?? "") }));
  const baseHref = tags.find((entry) => entry.tag === "base" && entry.attributes.get("href"))?.attributes.get("href") ?? "";
  const base = resolved(baseHref, pageUrl) ?? pageUrl;
  const links: URL[] = [];
  for (const { tag, attributes } of tags) {
    if (tag === "base") continue;
    if (tag === "link") {
      const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
      if (!rel.includes("next") && !rel.includes("alternate")) continue;
    }
    const url = resolved(attributes.get(tag === "frame" || tag === "iframe" ? "src" : "href") ?? "", base);
    if (url) links.push(url);
  }
  const specs: URL[] = [];
  for (const match of html.matchAll(SPEC_HINT)) {
    const url = resolved(decodeEntities(match[1]!), base);
    if (url && specUrl(url)) specs.push(url);
  }
  for (const match of html.matchAll(/\bspec-url\s*=\s*["']([^"']+)["']/gi)) {
    const url = resolved(decodeEntities(match[1]!), base);
    if (url) specs.push(url);
  }
  return { links, specs };
}

export function htmlTitle(html: string): string {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1] ?? "";
  return htmlText(raw).replace(/\s+/g, " ").slice(0, MAX_TITLE).trim();
}

export function loginWall(html: string, text: string, response: Pick<McpDocsResponse, "url" | "requested" | "redirected">): boolean {
  const toLogin = response.redirected && LOGIN_PATH.test(response.url.pathname) && !LOGIN_PATH.test(response.requested.pathname);
  const short = text.length < LOGIN_WALL_TEXT;
  if (PASSWORD_FIELD.test(html)) return short || toLogin;
  return toLogin && short;
}

function contentRun(lines: string[], common: (line: string) => boolean, order: number[], length: number): number {
  let run = 0;
  let first = -1;
  let unique = -1;
  for (const at of order) {
    const line = lines[at]!.trim();
    if (!line) continue;
    if (common(line)) {
      run = 0;
      continue;
    }
    if (unique < 0) unique = at;
    if (run === 0) first = at;
    run += 1;
    if (run === length) return first;
  }
  return unique;
}

export function withoutBoilerplate(pages: McpDocsPage[]): McpDocsPage[] {
  if (pages.length < BOILERPLATE_MIN_PAGES) return pages;
  const lines = pages.map((page) => page.text.split("\n"));
  const counts = new Map<string, number>();
  for (const list of lines) {
    for (const line of new Set(list.map((entry) => entry.trim()).filter(Boolean))) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const threshold = Math.max(BOILERPLATE_MIN_PAGES, Math.ceil(pages.length * BOILERPLATE_SHARE));
  const common = (line: string) => (counts.get(line) ?? 0) >= threshold;
  const kept = new Set<string>();
  return pages.map((page, index) => {
    const list = lines[index]!;
    const forward = list.map((_, at) => at);
    const start = contentRun(list, common, forward, CONTENT_RUN);
    const end = contentRun(list, common, [...forward].reverse(), 1);
    const body = start >= 0 && end >= start;
    const text = list
      .filter((line, at) => {
        const key = line.trim();
        if (!key || !common(key) || (body && at >= start && at <= end)) return true;
        if (kept.has(key)) return false;
        kept.add(key);
        return true;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { ...page, text };
  });
}

function secretsOf(auth: McpDocsAuth): string[] {
  const cookies = auth.type === "cookie" || (auth.type === "header" && auth.name.toLowerCase() === "cookie");
  const values = [auth.secret, ...(cookies ? auth.secret.split(";").map((part) => part.slice(part.indexOf("=") + 1)) : [])];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= MIN_SECRET_CHARS))].sort(
    (a, b) => b.length - a.length,
  );
}

export function withoutSecrets(text: string, auth: McpDocsAuth): string {
  return secretsOf(auth).reduce((current, secret) => current.split(secret).join("[credential]"), text);
}

function docsPage(site: McpDocsSite, url: URL, title: string, text: string): McpDocsPage {
  const { auth } = site.session;
  return { url: url.href, title: withoutSecrets(title, auth), text: withoutSecrets(text, auth) };
}

function textual(contentType: string, text: string): boolean {
  if (contentType) return TEXT_TYPES.test(contentType);
  return !text.includes("\u0000");
}

function limitHit(site: McpDocsSite, limit: McpCrawlLimit): true {
  site.stats.truncated ??= limit;
  return true;
}

function remember(site: McpDocsSite, text: string): boolean {
  const key = digest(text);
  if (site.texts.has(key)) return false;
  site.texts.add(key);
  return true;
}

function emptySite(link: McpDocsLink, index: number, fetchImpl: McpFetch, budget: McpCrawlBudget): McpDocsSite {
  const session = docsSession(link.url, fetchImpl, { type: link.auth, name: link.name, secret: link.secret });
  return {
    link: index,
    session,
    scopes: [directoryOf(session.start)],
    pages: [],
    specs: [],
    stats: { pages: 0, skipped: 0, failed: 0, truncated: null },
    budget,
    seen: new Set([docsPageUrl(session.start, session.auth).href]),
    texts: new Set(),
  };
}

function follows(site: McpDocsSite): (url: URL) => boolean {
  return (url) => !sameSite(site.session.start, url) || skippedUrl(url) !== "session";
}

async function visit(site: McpDocsSite, session: McpDocsSession, item: CrawlItem, found: Map<number, McpDocsPage>, queue: CrawlItem[], next: () => number) {
  const { budget } = site;
  budget.pages -= 1;
  const limit = Math.min(CRAWL_PAGE_BYTES, Math.max(0, budget.bytes));
  let response: McpDocsResponse;
  try {
    response = await loadDocsPage(session, item.url, limit, follows(site));
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (session.signal?.aborted) limitHit(site, "time");
    else if (code === "MCP_BUILDER_FETCH_SIZE" && limit < CRAWL_PAGE_BYTES) limitHit(site, "bytes");
    else if (code === "MCP_BUILDER_FETCH") site.stats.failed += 1;
    else if (code.startsWith("MCP_")) site.stats.skipped += 1;
    else site.stats.failed += 1;
    return;
  }
  budget.bytes -= response.bytes.byteLength;
  const final = response.url;
  if (final.href !== item.url.href) {
    if (site.seen.has(final.href)) return;
    site.seen.add(final.href);
  }
  if (!sameSite(site.session.start, final) || (!item.spec && !inCrawlScope(site, final))) {
    site.stats.skipped += 1;
    return;
  }
  const raw = Buffer.from(response.bytes).toString("utf8");
  if (!isHtml(response.contentType, raw)) {
    if (readApiDocument(raw)) {
      site.specs.push({ url: final.href, text: withoutSecrets(raw, site.session.auth) });
      return;
    }
    if (!textual(response.contentType, raw)) {
      site.stats.skipped += 1;
      return;
    }
    if (raw.trim() && remember(site, raw)) found.set(item.order, docsPage(site, final, "", raw.trim()));
    return;
  }
  const text = htmlText(raw);
  if (loginWall(raw, text, response)) {
    site.stats.skipped += 1;
    return;
  }
  enqueue(site, raw, final, item.depth, queue, next);
  if (text && remember(site, text)) found.set(item.order, docsPage(site, final, htmlTitle(raw), text));
}

function enqueue(site: McpDocsSite, html: string, pageUrl: URL, depth: number, queue: CrawlItem[], next: () => number) {
  const { links, specs } = pageLinks(html, pageUrl);
  const add = (raw: URL, spec: boolean) => {
    const url = docsPageUrl(raw, site.session.auth);
    if (!sameSite(site.session.start, url) || site.seen.has(url.href)) return;
    if (!spec && !inCrawlScope(site, url)) return;
    const skip = skippedUrl(url);
    if (skip === "asset") return;
    if (site.seen.size >= MAX_SEEN) {
      limitHit(site, "pages");
      return;
    }
    site.seen.add(url.href);
    if (skip === "session") {
      site.stats.skipped += 1;
      return;
    }
    if (!spec && depth + 1 > MAX_CRAWL_DEPTH) {
      limitHit(site, "depth");
      return;
    }
    const item = { url, depth: depth + 1, order: next(), spec };
    if (spec) queue.unshift(item);
    else queue.push(item);
  };
  for (const url of specs) add(url, true);
  for (const url of links) add(url, specUrl(url) && !inCrawlScope(site, url));
}

function halted(site: McpDocsSite): boolean {
  const { budget } = site;
  if (site.specs.length) return true;
  if (Date.now() >= budget.deadline) return limitHit(site, "time");
  if (budget.pages <= 0) return limitHit(site, "pages");
  if (budget.bytes <= 0) return limitHit(site, "bytes");
  return false;
}

async function crawlFrom(site: McpDocsSite, html: string, from: URL): Promise<void> {
  const queue: CrawlItem[] = [];
  const found = new Map<number, McpDocsPage>();
  let order = 0;
  const next = () => (order += 1);
  const session: McpDocsSession = { ...site.session, signal: AbortSignal.timeout(Math.max(1, site.budget.deadline - Date.now())) };
  enqueue(site, html, from, 0, queue, next);
  const running = new Set<Promise<void>>();
  for (;;) {
    while (queue.length && running.size < CRAWL_CONCURRENCY && !halted(site)) {
      const item = queue.shift()!;
      const task: Promise<void> = visit(site, session, item, found, queue, next).finally(() => running.delete(task));
      running.add(task);
    }
    if (!running.size) break;
    await Promise.race(running);
  }
  site.pages.push(...[...found.entries()].sort(([a], [b]) => a - b).map(([, page]) => page));
}

export async function crawlDocs(link: McpDocsLink, index: number, fetchImpl: McpFetch, budget: McpCrawlBudget): Promise<McpDocsCrawl> {
  const site = emptySite(link, index, fetchImpl, budget);
  const first = await loadDocsPage(site.session, site.session.start);
  budget.pages -= 1;
  budget.bytes -= first.bytes.byteLength;
  const raw = Buffer.from(first.bytes).toString("utf8");
  if (!isHtml(first.contentType, raw)) return { first, site: null };
  const text = htmlText(raw);
  if (loginWall(raw, text, first)) throw new Error("MCP_BUILDER_FETCH_AUTH");
  site.seen.add(first.url.href);
  if (sameSite(site.session.start, first.url) && !site.scopes.includes(directoryOf(first.url))) site.scopes.push(directoryOf(first.url));
  remember(site, text);
  if (text) site.pages.push(docsPage(site, first.url, htmlTitle(raw), text));
  if (link.crawl) await crawlFrom(site, raw, first.url);
  site.pages = withoutBoilerplate(site.pages);
  site.stats.pages = site.pages.length;
  return { first, site };
}

function fetchProblem(code: string): string {
  if (code === "MCP_BUILDER_FETCH_AUTH") return "The site rejected the sign-in of the documentation link for this page.";
  if (code === "MCP_BUILDER_FETCH_SIZE") return "The page is too large.";
  if (code === "MCP_BUILDER_FETCH_SKIPPED") return "The page redirects to an address the crawler does not open.";
  if (code.startsWith("MCP_URL_")) return "This address is not allowed.";
  return "The page could not be loaded.";
}

export async function fetchSitePage(site: McpDocsSite, raw: string): Promise<McpDocsFetched> {
  if (!URL.canParse(raw)) return { error: "Give a full http or https address." };
  const url = docsPageUrl(new URL(raw), site.session.auth);
  if (!sameSite(site.session.start, url)) return { error: "Only pages on the site of a documentation link can be fetched." };
  const known = site.pages.find((page) => page.url === url.href);
  if (known) return { page: known };
  if (skippedUrl(url)) return { error: "This address looks like a file, a sign-out, or a destructive action and is not opened." };
  if (site.budget.fetches <= 0) return { error: "The fetch limit for this draft is reached. Answer with what you have." };
  site.budget.fetches -= 1;
  let response: McpDocsResponse;
  try {
    response = await loadDocsPage(
      { ...site.session, signal: AbortSignal.timeout(FETCH_PAGE_TIMEOUT_MS) },
      url,
      CRAWL_PAGE_BYTES,
      follows(site),
    );
  } catch (err) {
    return { error: fetchProblem(err instanceof Error ? err.message : "") };
  }
  if (!sameSite(site.session.start, response.url)) return { error: "The page redirects to another site." };
  const text = Buffer.from(response.bytes).toString("utf8");
  let page: McpDocsPage;
  if (isHtml(response.contentType, text)) {
    const body = htmlText(text);
    if (loginWall(text, body, response)) return { error: "The page shows a sign-in form instead of documentation." };
    page = docsPage(site, response.url, htmlTitle(text), body);
  } else if (textual(response.contentType, text)) {
    page = docsPage(site, response.url, "", text.trim());
  } else {
    return { error: "The page is not text." };
  }
  site.seen.add(page.url);
  site.pages.push(page);
  site.stats.pages = site.pages.length;
  return { page };
}
