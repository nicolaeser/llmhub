import "server-only";
import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { modelAlias } from "@/lib/gateway/catalog/model-alias";
import { chatOnce, withDeployment } from "@/lib/gateway/dispatch/chat";
import { GateError } from "@/lib/gateway/errors";
import { inPool } from "@/lib/gateway/routing/route-pool";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { DRAFT_TIME_MS, draftWithAgent, turnOf } from "@/lib/mcp/builder-agent";
import { crawlBudget, crawlDocs, fetchSitePage, withoutSecrets } from "@/lib/mcp/docs-crawl";
import { sameSite } from "@/lib/mcp/docs-login";
import { docsLink, linkedText } from "@/lib/mcp/docs-source";
import { McpSourceError } from "@/lib/mcp/errors";
import { PICK_SYSTEM, readPick, templateAllows } from "@/lib/mcp/hosted";
import { importOpenApi, readApiDocument } from "@/lib/mcp/openapi";
import { guardedFetch } from "@/lib/mcp/transport";
import { modelRole } from "@/lib/models/model-role";
import { extensionOf, extractDocument } from "@/lib/rag/extract";
import {
  BUILDER_MODEL_KEY,
  MAX_BUILDER_FILES,
  MAX_BUILDER_FILE_BYTES,
  MAX_BUILDER_UPLOAD_BYTES,
  MAX_HOSTED_TOOLS,
  builderDraftSchema,
  builderModelSchema,
} from "@/schemas/mcp";
import type { JsonMap } from "@/types/gateway";
import type {
  HostedTool,
  McpBuilderLibrary,
  McpBuilderModel,
  McpBuilderTemplate,
  McpBuilderTurn,
  McpBuilderUpload,
  McpCrawlBudget,
  McpCrawlSummary,
  McpDocsCrawl,
  McpDocsFetched,
  McpDocsLink,
  McpDocsSite,
  McpDocsSource,
  McpDocsSourceRef,
  McpDraft,
} from "@/types/mcp";
import type { Extraction } from "@/types/rag";

const DRAFT_MAX_TOKENS = 16_000;
const MAX_FILE_NAME = 200;
const MODEL_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,/;
const LINKED_FILE_TYPES = /^(?:application\/pdf|image\/|application\/vnd\.openxmlformats-officedocument\.)/i;
const LINKED_FILE_EXTENSIONS = new Set(["pdf", "docx", "pptx", "xlsx", "png", "jpg", "jpeg", "webp", "gif"]);
const CONTEXT_LIMIT = /context[ _-]?(?:length|window)|too many tokens|prompt is too long|maximum.{0,40}tokens/i;
const MODEL_INPUT_STATUSES = new Set([400, 413, 415, 422]);
const DRAFT_CODES = new Set(["MCP_BUILDER_MODEL", "MCP_BUILDER_DRAFT", "MCP_BUILDER_EMPTY"]);

type LinkRead = { sources: McpDocsSource[]; site: McpDocsSite | null; crawl: boolean };

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("VALIDATION");
  return parsed.data;
}

function contextLimited(err: GateError): boolean {
  return err.status === 413 || err.code === "context_length_exceeded" || CONTEXT_LIMIT.test(err.message);
}

export async function builderModels(): Promise<McpBuilderModel[]> {
  const groups = await prisma.modelGroup.findMany({
    where: { enabled: true },
    select: {
      alias: true,
      displayName: true,
      deployments: { select: { kind: true, model: true, provider: { select: { kind: true } } } },
    },
    orderBy: { alias: "asc" },
  });
  return groups
    .filter(
      (group) =>
        group.deployments.some(inPool("api")) &&
        modelRole([...group.deployments.map((deployment) => deployment.model), group.alias, group.displayName]) === "chat",
    )
    .map((group) => ({ alias: group.alias, label: group.displayName || group.alias }));
}

async function builderAlias(): Promise<string> {
  const setting = await prisma.setting.findUnique({ where: { key: BUILDER_MODEL_KEY } });
  const alias = modelAlias(setting?.value ?? "");
  if (!alias) return "";
  return (await builderModels()).some((model) => model.alias === alias) ? alias : "";
}

function requestVariants(messages: JsonMap[], tools: JsonMap[] | null): JsonMap[] {
  const plain = [{ messages, max_tokens: DRAFT_MAX_TOKENS }, { messages }];
  if (!tools) return plain;
  const withTools = [{ messages, tools, max_tokens: DRAFT_MAX_TOKENS }, { messages, tools }];
  return messages.some((message) => message.role === "tool") ? withTools : [...withTools, ...plain];
}

async function complete(alias: string, messages: JsonMap[], tools: JsonMap[] | null = null): Promise<McpBuilderTurn> {
  const variants = requestVariants(messages, tools);
  try {
    const routed = await withDeployment(
      [alias],
      {},
      async (deployment, group) => {
        for (let at = 0; ; at += 1) {
          const body = variants[at]!;
          try {
            return turnOf(await chatOnce(deployment, group, body, alias), "tools" in body);
          } catch (err) {
            if (at === variants.length - 1 || !(err instanceof GateError) || err.status !== 400 || contextLimited(err)) throw err;
          }
        }
      },
      { pool: "api" },
    );
    return routed.result;
  } catch (err) {
    if (err instanceof GateError && err.code === "model_not_found") throw new Error("MCP_BUILDER_MODEL", { cause: err });
    throw err;
  }
}

function fileName(raw: string, fallback: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = [...base]
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join("")
    .trim();
  return clean.slice(0, MAX_FILE_NAME) || fallback;
}

function sourceLabel(ref: McpDocsSourceRef): string {
  return ref.kind === "text" ? "pasted text" : ref.name;
}

function textSource(ref: McpDocsSourceRef, text: string, link: string): McpDocsSource {
  return { ref, text, link, pages: [{ url: "", title: "", text }] };
}

function readFile(ref: McpDocsSourceRef, filename: string, upload: McpBuilderUpload, pointer: string): McpDocsSource {
  let extraction: Extraction;
  try {
    extraction = extractDocument({ filename, contentType: upload.type, payload: upload.bytes });
  } catch {
    throw new McpSourceError("MCP_BUILDER_FILE_UNSUPPORTED", pointer);
  }
  if (extraction.kind === "text" && extraction.text.trim()) return textSource(ref, extraction.text, "");
  if (extraction.kind === "ocr") {
    const { document } = extraction;
    if (typeof document.document_url === "string") {
      return { ref, part: { type: "file", file: { filename, file_data: document.document_url } } };
    }
    if (typeof document.image_url === "string" && MODEL_IMAGE.test(document.image_url)) {
      return { ref, part: { type: "image_url", image_url: { url: document.image_url } } };
    }
  }
  throw new McpSourceError("MCP_BUILDER_FILE_UNSUPPORTED", pointer);
}

function readUploads(uploads: McpBuilderUpload[]): McpDocsSource[] {
  if (uploads.length > MAX_BUILDER_FILES) throw new Error("MCP_BUILDER_FILES_COUNT");
  uploads.forEach((upload, index) => {
    if (upload.bytes.byteLength > MAX_BUILDER_FILE_BYTES) throw new McpSourceError("MCP_BUILDER_FILE_SIZE", `#/files/${index}`);
  });
  const total = uploads.reduce((sum, upload) => sum + upload.bytes.byteLength, 0);
  if (total > MAX_BUILDER_UPLOAD_BYTES) throw new Error("MCP_BUILDER_FILES_SIZE");
  return uploads.map((upload, index) => {
    const name = fileName(upload.name, `file-${index + 1}`);
    return readFile({ kind: "file", name }, name, upload, `#/files/${index}`);
  });
}

function withoutSearch(url: URL): string {
  const copy = new URL(url);
  copy.search = "";
  return copy.toString();
}

async function readLink(link: McpDocsLink, index: number, pointer: string, budget: McpCrawlBudget): Promise<LinkRead> {
  const ref: McpDocsSourceRef = { kind: "link", name: new URL(link.url).host };
  let crawled: McpDocsCrawl;
  try {
    crawled = await crawlDocs(link, index, guardedFetch(link.internal), budget);
  } catch (err) {
    throw new McpSourceError(err instanceof Error && /^MCP_[A-Z_]+$/.test(err.message) ? err.message : "MCP_BUILDER_FETCH", pointer);
  }
  const { first, site } = crawled;
  if (site) {
    const spec = site.specs[0];
    const sources: McpDocsSource[] = spec
      ? [textSource(ref, spec.text, withoutSearch(new URL(spec.url)))]
      : [{ ref, text: site.pages[0]?.text ?? "", link: withoutSearch(first.url), pages: site.pages }];
    return { sources, site, crawl: link.crawl };
  }
  const name = fileName(first.url.pathname, ref.name);
  if (LINKED_FILE_TYPES.test(first.contentType) || LINKED_FILE_EXTENSIONS.has(extensionOf(name))) {
    return { sources: [readFile(ref, name, { name, type: first.contentType, bytes: first.bytes }, pointer)], site: null, crawl: false };
  }
  const text = withoutSecrets(linkedText(first), { type: link.auth, name: link.name, secret: link.secret });
  return { sources: [textSource(ref, text, withoutSearch(first.url))], site: null, crawl: false };
}

export async function setBuilderModel(raw: unknown): Promise<{ model: string }> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const alias = modelAlias(parse(builderModelSchema, raw));
  if (alias && !(await builderModels()).some((model) => model.alias === alias)) throw new Error("MCP_BUILDER_MODEL");
  await prisma.setting.upsert({
    where: { key: BUILDER_MODEL_KEY },
    update: { value: alias },
    create: { key: BUILDER_MODEL_KEY, value: alias },
  });
  return { model: alias };
}

async function pickOperations(instruction: string, tools: HostedTool[]): Promise<string[] | null> {
  const alias = await builderAlias();
  if (!alias) return null;
  const operations = tools.map((tool) => `${tool.name} ${tool.method} ${tool.path} ${tool.title}`).join("\n");
  try {
    const answer = await complete(alias, [
      { role: "system", content: PICK_SYSTEM },
      { role: "user", content: `Request:\n${instruction}\n\nOperations:\n${operations}` },
    ]);
    return readPick(answer.text, tools);
  } catch (err) {
    logger.warn("mcp.builder_pick_failed", errorFields(err));
    return null;
  }
}

type DraftBody = Omit<McpDraft, "crawls">;

async function draftFromSpec(
  template: McpBuilderTemplate,
  instruction: string,
  document: JsonMap,
  origin: Extract<McpDocsSource, { text: string }>,
  others: McpDocsSource[],
): Promise<DraftBody> {
  const imported = importOpenApi(document, origin.link);
  if (!imported.tools.length) throw new Error("MCP_BUILDER_EMPTY");
  const picked =
    template === "custom"
      ? await pickOperations(instruction, imported.tools)
      : imported.tools.filter((tool) => templateAllows(template, tool.action)).map((tool) => tool.name);
  const wanted = new Set(picked ?? imported.tools.map((tool) => tool.name));
  const first = [...imported.tools.filter((tool) => wanted.has(tool.name)), ...imported.tools.filter((tool) => !wanted.has(tool.name))];
  const kept = new Set(first.slice(0, MAX_HOSTED_TOOLS).map((tool) => tool.name));
  const tools = imported.tools.filter((tool) => kept.has(tool.name));
  return {
    ...imported.server,
    tools,
    included: tools.filter((tool) => wanted.has(tool.name)).map((tool) => tool.name),
    source: "openapi",
    operations: imported.operations,
    importedFrom: origin.ref,
    unused: others.map((source) => source.ref),
    passes: 0,
    parts: 0,
  };
}

function draftFailure(err: unknown, attached: boolean): Error {
  if (err instanceof Error && DRAFT_CODES.has(err.message)) return err;
  if (err instanceof GateError && MODEL_INPUT_STATUSES.has(err.status)) {
    if (contextLimited(err)) return new Error("MCP_BUILDER_DOCS_LONG", { cause: err });
    if (attached) return new Error("MCP_BUILDER_MODEL_FILES", { cause: err });
  }
  return new Error("MCP_BUILDER_DRAFT", { cause: err });
}

function libraryOf(sources: McpDocsSource[], fetchPage: McpBuilderLibrary["fetchPage"]): McpBuilderLibrary {
  const library: McpBuilderLibrary = { sections: [], attachments: [], fetchPage };
  sources.forEach((source, index) => {
    const label = `Source ${index + 1}: ${sourceLabel(source.ref)}`;
    if ("text" in source) library.sections.push({ label, pages: source.pages });
    else library.attachments.push({ type: "text", text: `${label} (attached file)` }, source.part);
  });
  return library;
}

function sitePageFetcher(sites: McpDocsSite[]): McpBuilderLibrary["fetchPage"] {
  if (!sites.length) return null;
  return async (raw: string): Promise<McpDocsFetched> => {
    const site = URL.canParse(raw) ? sites.find((entry) => sameSite(entry.session.start, new URL(raw))) : undefined;
    if (!site) return { error: "Only pages on the site of a documentation link with sub pages turned on can be fetched." };
    return fetchSitePage(site, raw);
  };
}

async function draftFromModel(
  instruction: string,
  sources: McpDocsSource[],
  sites: McpDocsSite[],
  deadline: number,
): Promise<DraftBody> {
  const alias = await builderAlias();
  if (!alias) throw new Error("MCP_BUILDER_MODEL");
  const library = libraryOf(sources, sitePageFetcher(sites));
  let result;
  try {
    result = await draftWithAgent({
      instruction,
      library,
      complete: (messages, tools) => complete(alias, messages, tools),
      deadline,
    });
  } catch (err) {
    throw draftFailure(err, library.attachments.length > 0);
  }
  logger.info("mcp.builder_drafted", { passes: result.passes, parts: result.parts, tools: result.tools.length });
  return {
    ...result.server,
    tools: result.tools,
    included: result.tools.map((tool) => tool.name),
    source: "model",
    operations: result.tools.length,
    importedFrom: null,
    unused: [],
    passes: result.passes,
    parts: result.parts,
  };
}

function crawlSummaries(reads: LinkRead[]): McpCrawlSummary[] {
  return reads.flatMap(({ site, crawl }) => {
    if (!site || !crawl) return [];
    const { origin, pathname } = site.session.start;
    return [{ link: site.link, url: `${origin}${pathname}`, ...site.stats }];
  });
}

export async function draftMcpServer(raw: unknown, uploads: McpBuilderUpload[] = []): Promise<McpDraft> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(builderDraftSchema, raw);
  if (!input.links.length && !input.docs && !uploads.length) throw new Error("VALIDATION");
  const files = readUploads(uploads);
  const pasted = docsLink(input.docs);
  const started = Date.now();
  const budget = crawlBudget(started);
  const reads = await Promise.all(input.links.map((link, index) => readLink(link, index, `#/links/${index}`, budget)));
  if (pasted) {
    reads.push(
      await readLink({ url: pasted, internal: false, crawl: true, auth: "none", name: "", secret: "" }, input.links.length, "#/docs", budget),
    );
  }
  const typed: McpDocsSource[] =
    input.docs && !pasted ? [textSource({ kind: "text", name: "" }, input.docs, "")] : [];
  const sources = [...reads.flatMap((read) => read.sources), ...typed, ...files];
  const crawls = crawlSummaries(reads);
  for (const crawl of crawls) {
    logger.info("mcp.builder_crawl", {
      link: crawl.link,
      pages: crawl.pages,
      skipped: crawl.skipped,
      failed: crawl.failed,
      truncated: crawl.truncated ?? "",
    });
  }
  for (const source of sources) {
    if (!("text" in source)) continue;
    const document = readApiDocument(source.text);
    if (document) {
      const draft = await draftFromSpec(
        input.template,
        input.instruction,
        document,
        source,
        sources.filter((other) => other !== source),
      );
      return { ...draft, crawls };
    }
  }
  const sites = reads.flatMap((read) => (read.site && read.crawl ? [read.site] : []));
  const draft = await draftFromModel(input.instruction, sources, sites, started + DRAFT_TIME_MS);
  return { ...draft, crawls: crawlSummaries(reads) };
}
