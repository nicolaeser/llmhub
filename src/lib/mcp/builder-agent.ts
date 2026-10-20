import "server-only";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { BUILDER_SYSTEM, continuePrompt, mergeTools, passPrompt, readDraft } from "@/lib/mcp/hosted";
import { parseJsonOrNull } from "@/lib/utils/json";
import { MAX_HOSTED_TOOLS } from "@/schemas/mcp";
import type { JsonMap } from "@/types/gateway";
import type {
  HostedTool,
  McpBuilderComplete,
  McpBuilderLibrary,
  McpBuilderResult,
  McpBuilderSection,
  McpBuilderTurn,
  McpDocsPage,
  McpDraftServer,
  McpToolCall,
} from "@/types/mcp";

export const MAX_MODEL_DOCS = 200_000;
export const PASS_DOCS_CHARS = 150_000;
export const SITE_INDEX_CHARS = 30_000;
export const MAX_DRAFT_PASSES = 6;
export const MAX_DRAFT_ROUNDS = 3;
export const MAX_AGENT_STEPS = 6;
export const MAX_AGENT_CHARS = 300_000;
export const MAX_TOOL_CALLS_PER_STEP = 8;
export const READ_PAGE_CHARS = 30_000;
export const DRAFT_TIME_MS = 270_000;

const LIST_PAGES: JsonMap = {
  type: "function",
  function: {
    name: "list_pages",
    description: "List the crawled documentation pages with their addresses and titles.",
    parameters: {
      type: "object",
      properties: { filter: { type: "string", description: "Only pages whose address or title contains this text." } },
    },
  },
};

const READ_PAGE: JsonMap = {
  type: "function",
  function: {
    name: "read_page",
    description: "Read the full text of a crawled documentation page.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Address of the page from the site index or list_pages." },
        offset: { type: "integer", description: "Character offset to continue a long page." },
      },
      required: ["url"],
    },
  },
};

const FETCH_PAGE: JsonMap = {
  type: "function",
  function: {
    name: "fetch_page",
    description:
      "Load a documentation page that was not crawled, on the site of one of the documentation links. It uses the sign-in of that link.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full address of the page." },
        offset: { type: "integer", description: "Character offset to continue a long page." },
      },
      required: ["url"],
    },
  },
};

type AgentContext = {
  complete: McpBuilderComplete;
  library: McpBuilderLibrary;
  pages: Map<string, McpDocsPage>;
  tools: JsonMap[] | null;
  deadline: number;
};

type PassPlan = { chunks: string[]; parts: number };

function asMap(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : null;
}

function messageText(message: JsonMap): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const text = asMap(part)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function callsOf(message: JsonMap): McpToolCall[] {
  const listed = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return listed.flatMap((raw, index) => {
    const call = asMap(raw);
    const fn = asMap(call?.function);
    if (!call || typeof fn?.name !== "string") return [];
    return [
      {
        id: typeof call.id === "string" && call.id ? call.id : `call_${index + 1}`,
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    ];
  });
}

export function turnOf(json: unknown, toolsAccepted: boolean): McpBuilderTurn {
  const choices = asMap(json)?.choices;
  const choice = asMap(Array.isArray(choices) ? choices[0] : null);
  const message = asMap(choice?.message) ?? {};
  return { message, text: messageText(message), cut: choice?.finish_reason === "length", calls: callsOf(message), toolsAccepted };
}

function pageHead(page: McpDocsPage): string {
  return [page.url ? `Page: ${page.url}` : "", page.title ? `Title: ${page.title}` : ""].filter(Boolean).join("\n");
}

function sectionText(section: McpBuilderSection): string {
  if (section.pages.length === 1) return `${section.label}\n${section.pages[0]!.text}`;
  const pages = section.pages.map((page) => [pageHead(page), page.text].filter(Boolean).join("\n"));
  return `${section.label} (${section.pages.length} pages)\n\n${pages.join("\n\n")}`;
}

function splitText(text: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n\n", size);
    if (cut < size / 2) cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest || !pieces.length) pieces.push(rest);
  return pieces;
}

function blocksOf(library: McpBuilderLibrary): string[] {
  return library.sections.flatMap((section) =>
    section.pages.flatMap((page) => {
      const head = [section.label, pageHead(page)].filter(Boolean).join("\n");
      const pieces = splitText(page.text, PASS_DOCS_CHARS - head.length - 40);
      return pieces.map((piece, at) => `${head}${pieces.length > 1 ? `\nPart ${at + 1} of ${pieces.length} of this page` : ""}\n${piece}`);
    }),
  );
}

export function planPasses(library: McpBuilderLibrary): PassPlan {
  const whole = library.sections.map(sectionText).join("\n\n");
  if (whole.length <= MAX_MODEL_DOCS) return { chunks: [whole], parts: 1 };
  const chunks: string[] = [];
  let current = "";
  for (const block of blocksOf(library)) {
    if (current && current.length + block.length + 2 > PASS_DOCS_CHARS) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) chunks.push(current);
  return { chunks: chunks.slice(0, MAX_DRAFT_PASSES), parts: chunks.length };
}

function indexedPages(library: McpBuilderLibrary): Map<string, McpDocsPage> {
  const pages = new Map<string, McpDocsPage>();
  for (const section of library.sections) for (const page of section.pages) if (page.url && !pages.has(page.url)) pages.set(page.url, page);
  return pages;
}

function pageLine(page: McpDocsPage): string {
  return `- ${page.url}${page.title ? ` | ${page.title}` : ""}`;
}

export function siteIndex(pages: McpDocsPage[]): string {
  if (!pages.length) return "";
  const lines: string[] = [];
  let size = 0;
  for (const [at, page] of pages.entries()) {
    const line = pageLine(page);
    if (size + line.length + 1 > SITE_INDEX_CHARS) {
      lines.push(`And ${pages.length - at} more pages. Call list_pages to see them.`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return `Site index, ${pages.length} crawled pages:\n${lines.join("\n")}`;
}

function clipped(text: string, size: number): string {
  return text.length > size ? `${text.slice(0, Math.max(0, size))}\n[truncated]` : text;
}

function pageFor(ctx: AgentContext, raw: string): McpDocsPage | null {
  const value = raw.trim();
  const direct = ctx.pages.get(value);
  if (direct || !URL.canParse(value)) return direct ?? null;
  const url = new URL(value);
  url.hash = "";
  const key = url.href;
  return ctx.pages.get(key) ?? ctx.pages.get(key.endsWith("/") ? key.slice(0, -1) : `${key}/`) ?? null;
}

function pageSlice(page: McpDocsPage, offset: number, room: number): string {
  const start = Math.max(0, Math.min(offset, page.text.length));
  const text = page.text.slice(start, start + Math.max(0, Math.min(READ_PAGE_CHARS, room)));
  const next = start + text.length;
  const more = next < page.text.length ? `\n\n[The page continues. Call read_page with offset ${next}.]` : "";
  return `${[pageHead(page), text].filter(Boolean).join("\n\n")}${more}`;
}

async function runTool(ctx: AgentContext, call: McpToolCall, room: number): Promise<string> {
  const args = call.arguments.trim() ? asMap(parseJsonOrNull(call.arguments)) : {};
  if (!args) return "[tool error] Invalid arguments: expected a JSON object.";
  const url = typeof args.url === "string" ? args.url : "";
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.floor(args.offset) : 0;
  if (call.name === "list_pages") {
    const filter = typeof args.filter === "string" ? args.filter.trim().toLowerCase() : "";
    const listed = [...ctx.pages.values()].filter(
      (page) => !filter || page.url.toLowerCase().includes(filter) || page.title.toLowerCase().includes(filter),
    );
    if (!listed.length) return "No crawled page matches.";
    return clipped(listed.map((page) => `${pageLine(page)} (${page.text.length} characters)`).join("\n"), Math.min(READ_PAGE_CHARS, room));
  }
  if (call.name === "read_page") {
    const page = pageFor(ctx, url);
    return page ? pageSlice(page, offset, room) : "[tool error] This page was not crawled. Call list_pages, or fetch_page for a linked page.";
  }
  if (call.name === "fetch_page") {
    const known = pageFor(ctx, url);
    if (known) return pageSlice(known, offset, room);
    if (!ctx.library.fetchPage) return "[tool error] Fetching pages is not available for these sources.";
    const fetched = await ctx.library.fetchPage(url);
    if ("error" in fetched) return `[tool error] ${fetched.error}`;
    ctx.pages.set(fetched.page.url, fetched.page);
    return pageSlice(fetched.page, offset, room);
  }
  return "[tool error] Unknown tool.";
}

function assistantStep(turn: McpBuilderTurn): JsonMap {
  return {
    role: "assistant",
    content: typeof turn.message.content === "string" ? turn.message.content : null,
    tool_calls: turn.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
  };
}

async function runAgent(ctx: AgentContext, content: string | JsonMap[], promptChars: number): Promise<McpBuilderTurn> {
  const messages: JsonMap[] = [
    { role: "system", content: BUILDER_SYSTEM },
    { role: "user", content },
  ];
  let room = MAX_AGENT_CHARS - promptChars;
  for (let step = 1; ; step += 1) {
    const offered = ctx.tools && step < MAX_AGENT_STEPS && room > 0 && Date.now() < ctx.deadline ? ctx.tools : null;
    const turn = await ctx.complete(messages, offered);
    if (offered && !turn.toolsAccepted) ctx.tools = null;
    if (!offered || !turn.toolsAccepted || !turn.calls.length) return turn;
    messages.push(assistantStep(turn));
    for (const [index, call] of turn.calls.entries()) {
      const usable = index < MAX_TOOL_CALLS_PER_STEP && room > 0 && Date.now() < ctx.deadline;
      const result = usable ? await runTool(ctx, call, room) : "[tool error] Skipped: the tool budget of this draft is used up.";
      room -= result.length;
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
}

function userContent(text: string, attachments: JsonMap[], extra = ""): string | JsonMap[] {
  if (!attachments.length) return extra ? `${text}\n\n${extra}` : text;
  return [{ type: "text", text }, ...attachments, ...(extra ? [{ type: "text", text: extra }] : [])];
}

export async function draftWithAgent(input: {
  instruction: string;
  library: McpBuilderLibrary;
  complete: McpBuilderComplete;
  deadline: number;
}): Promise<McpBuilderResult> {
  const { library } = input;
  const pages = indexedPages(library);
  const plan = planPasses(library);
  const tools = library.fetchPage ? [LIST_PAGES, READ_PAGE, FETCH_PAGE] : pages.size > 1 ? [LIST_PAGES, READ_PAGE] : null;
  const ctx: AgentContext = { complete: input.complete, library, pages, tools, deadline: input.deadline };
  const index = tools ? siteIndex([...pages.values()]) : "";
  let server: McpDraftServer | null = null;
  let drafted: HostedTool[] = [];
  let passes = 0;
  for (const [at, chunk] of plan.chunks.entries()) {
    if (at > 0 && (Date.now() >= input.deadline || drafted.length >= MAX_HOSTED_TOOLS)) break;
    const names = drafted.map((tool) => tool.name);
    const note = plan.parts > 1 ? passPrompt(at + 1, plan.parts, names) : "";
    const unread =
      plan.parts > plan.chunks.length && at === plan.chunks.length - 1
        ? `The last ${plan.parts - plan.chunks.length} parts are not shown here. Read their pages with read_page when they describe operations.`
        : "";
    const request = [`Request:\n${input.instruction}`, note, unread, index, `API documentation:\n${chunk || "See the attached files."}`]
      .filter(Boolean)
      .join("\n\n");
    const attachments = at === 0 ? library.attachments : [];
    let turn: McpBuilderTurn;
    try {
      turn = await runAgent(ctx, userContent(request, attachments), request.length);
    } catch (err) {
      if (at === 0) throw err;
      logger.warn("mcp.builder_pass_failed", { pass: at + 1, ...errorFields(err) });
      continue;
    }
    passes += 1;
    const reading = readDraft(turn.text);
    server ??= reading.server;
    drafted = mergeTools(drafted, reading.tools);
    let cut = turn.cut || reading.cut;
    for (let round = 1; cut && round < MAX_DRAFT_ROUNDS && drafted.length < MAX_HOSTED_TOOLS && Date.now() < input.deadline; round += 1) {
      const ask = userContent(request, attachments, continuePrompt(drafted.map((tool) => tool.name)));
      let more: McpBuilderTurn;
      try {
        more = await input.complete(
          [
            { role: "system", content: BUILDER_SYSTEM },
            { role: "user", content: ask },
          ],
          null,
        );
      } catch (err) {
        logger.warn("mcp.builder_round_failed", { round, ...errorFields(err) });
        break;
      }
      const next = readDraft(more.text);
      server ??= next.server;
      const before = drafted.length;
      drafted = mergeTools(drafted, next.tools);
      if (drafted.length === before) break;
      cut = more.cut || next.cut;
    }
  }
  if (!server) throw new Error("MCP_BUILDER_DRAFT");
  if (!drafted.length) throw new Error("MCP_BUILDER_EMPTY");
  return { server, tools: drafted, passes, parts: plan.parts };
}
