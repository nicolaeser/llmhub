import "server-only";
import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { modelAlias } from "@/lib/gateway/catalog/model-alias";
import { asRecord } from "@/lib/gateway/core";
import { chatOnce, withDeployment } from "@/lib/gateway/dispatch/chat";
import { GateError } from "@/lib/gateway/errors";
import { inPool } from "@/lib/gateway/routing/route-pool";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { docsLink, fetchDocs, linkedText } from "@/lib/mcp/docs-source";
import { McpSourceError } from "@/lib/mcp/errors";
import { BUILDER_SYSTEM, PICK_SYSTEM, continuePrompt, mergeTools, readDraft, readPick, templateAllows } from "@/lib/mcp/hosted";
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
  McpBuilderModel,
  McpBuilderTemplate,
  McpBuilderUpload,
  McpDocsLink,
  McpDocsSource,
  McpDocsSourceRef,
  McpDraft,
  McpLinkedDocument,
} from "@/types/mcp";
import type { Extraction } from "@/types/rag";

const DRAFT_MAX_TOKENS = 16_000;
const MAX_DRAFT_ROUNDS = 3;
const MAX_MODEL_DOCS = 200_000;
const MAX_FILE_NAME = 200;
const MODEL_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,/;
const LINKED_FILE_TYPES = /^(?:application\/pdf|image\/|application\/vnd\.openxmlformats-officedocument\.)/i;
const LINKED_FILE_EXTENSIONS = new Set(["pdf", "docx", "pptx", "xlsx", "png", "jpg", "jpeg", "webp", "gif"]);
const CONTEXT_LIMIT = /context[ _-]?(?:length|window)|too many tokens|prompt is too long|maximum.{0,40}tokens/i;
const MODEL_INPUT_STATUSES = new Set([400, 413, 415, 422]);

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("VALIDATION");
  return parsed.data;
}

function assistantText(json: unknown): string {
  const root = asRecord(json);
  const choices = root && Array.isArray(root.choices) ? root.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const text = asRecord(part)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function stoppedEarly(json: unknown): boolean {
  const choices = asRecord(json)?.choices;
  return Array.isArray(choices) && asRecord(choices[0])?.finish_reason === "length";
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

async function complete(alias: string, messages: JsonMap[]): Promise<{ text: string; cut: boolean }> {
  try {
    const routed = await withDeployment(
      [alias],
      {},
      async (deployment, group) => {
        try {
          return await chatOnce(deployment, group, { messages, max_tokens: DRAFT_MAX_TOKENS }, alias);
        } catch (err) {
          if (!(err instanceof GateError) || err.status !== 400) throw err;
          return chatOnce(deployment, group, { messages }, alias);
        }
      },
      { pool: "api" },
    );
    return { text: assistantText(routed.result), cut: stoppedEarly(routed.result) };
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

function readFile(ref: McpDocsSourceRef, filename: string, upload: McpBuilderUpload, pointer: string): McpDocsSource {
  let extraction: Extraction;
  try {
    extraction = extractDocument({ filename, contentType: upload.type, payload: upload.bytes });
  } catch {
    throw new McpSourceError("MCP_BUILDER_FILE_UNSUPPORTED", pointer);
  }
  if (extraction.kind === "text" && extraction.text.trim()) return { ref, text: extraction.text, link: "" };
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

async function readLink(link: McpDocsLink, pointer: string): Promise<McpDocsSource> {
  const ref: McpDocsSourceRef = { kind: "link", name: new URL(link.url).host };
  let doc: McpLinkedDocument;
  try {
    doc = await fetchDocs(link.url, guardedFetch(link.internal), { type: link.auth, name: link.name, secret: link.secret });
  } catch (err) {
    throw new McpSourceError(err instanceof Error && /^MCP_[A-Z_]+$/.test(err.message) ? err.message : "MCP_BUILDER_FETCH", pointer);
  }
  const name = fileName(new URL(doc.url).pathname, ref.name);
  if (LINKED_FILE_TYPES.test(doc.contentType) || LINKED_FILE_EXTENSIONS.has(extensionOf(name))) {
    return readFile(ref, name, { name, type: doc.contentType, bytes: doc.bytes }, pointer);
  }
  return { ref, text: linkedText(doc), link: doc.url };
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

async function draftFromSpec(
  template: McpBuilderTemplate,
  instruction: string,
  document: JsonMap,
  origin: Extract<McpDocsSource, { text: string }>,
  others: McpDocsSource[],
): Promise<McpDraft> {
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
  };
}

function draftFailure(err: unknown, attached: boolean): Error {
  if (err instanceof Error && err.message === "MCP_BUILDER_MODEL") return err;
  if (err instanceof GateError && MODEL_INPUT_STATUSES.has(err.status)) {
    if (err.status === 413 || err.code === "context_length_exceeded" || CONTEXT_LIMIT.test(err.message)) {
      return new Error("MCP_BUILDER_DOCS_LONG", { cause: err });
    }
    if (attached) return new Error("MCP_BUILDER_MODEL_FILES", { cause: err });
  }
  return new Error("MCP_BUILDER_DRAFT", { cause: err });
}

async function draftFromModel(instruction: string, sources: McpDocsSource[]): Promise<McpDraft> {
  const sections: string[] = [];
  const attachments: JsonMap[] = [];
  sources.forEach((source, index) => {
    const label = `Source ${index + 1}: ${sourceLabel(source.ref)}`;
    if ("text" in source) sections.push(`${label}\n${source.text}`);
    else attachments.push({ type: "text", text: `${label} (attached file)` }, source.part);
  });
  const docs = sections.join("\n\n");
  if (docs.length > MAX_MODEL_DOCS) throw new Error("MCP_BUILDER_DOCS_LONG");
  const alias = await builderAlias();
  if (!alias) throw new Error("MCP_BUILDER_MODEL");
  const request = `Request:\n${instruction}\n\nAPI documentation:\n${docs || "See the attached files."}`;
  const ask = (extra: string): JsonMap[] => {
    const content = attachments.length
      ? [{ type: "text", text: request }, ...attachments, ...(extra ? [{ type: "text", text: extra }] : [])]
      : extra
        ? `${request}\n\n${extra}`
        : request;
    return [
      { role: "system", content: BUILDER_SYSTEM },
      { role: "user", content },
    ];
  };
  let answer: { text: string; cut: boolean };
  try {
    answer = await complete(alias, ask(""));
  } catch (err) {
    throw draftFailure(err, attachments.length > 0);
  }
  const first = readDraft(answer.text);
  if (!first.server) throw new Error("MCP_BUILDER_DRAFT");
  let tools = first.tools;
  let cut = answer.cut || first.cut;
  for (let round = 1; cut && round < MAX_DRAFT_ROUNDS && tools.length < MAX_HOSTED_TOOLS; round += 1) {
    let more: { text: string; cut: boolean };
    try {
      more = await complete(alias, ask(continuePrompt(tools.map((tool) => tool.name))));
    } catch (err) {
      logger.warn("mcp.builder_round_failed", { round, ...errorFields(err) });
      break;
    }
    const reading = readDraft(more.text);
    const before = tools.length;
    tools = mergeTools(tools, reading.tools);
    if (tools.length === before) break;
    cut = more.cut || reading.cut;
  }
  if (!tools.length) throw new Error("MCP_BUILDER_EMPTY");
  return {
    ...first.server,
    tools,
    included: tools.map((tool) => tool.name),
    source: "model",
    operations: tools.length,
    importedFrom: null,
    unused: [],
  };
}

export async function draftMcpServer(raw: unknown, uploads: McpBuilderUpload[] = []): Promise<McpDraft> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(builderDraftSchema, raw);
  if (!input.links.length && !input.docs && !uploads.length) throw new Error("VALIDATION");
  const files = readUploads(uploads);
  const pasted = docsLink(input.docs);
  const linked = await Promise.all(input.links.map((link, index) => readLink(link, `#/links/${index}`)));
  const typed: McpDocsSource[] = pasted
    ? [await readLink({ url: pasted, internal: false, auth: "none", name: "", secret: "" }, "#/docs")]
    : input.docs
      ? [{ ref: { kind: "text", name: "" }, text: input.docs, link: "" }]
      : [];
  const sources = [...linked, ...typed, ...files];
  for (const source of sources) {
    if (!("text" in source)) continue;
    const document = readApiDocument(source.text);
    if (document) {
      return draftFromSpec(
        input.template,
        input.instruction,
        document,
        source,
        sources.filter((other) => other !== source),
      );
    }
  }
  return draftFromModel(input.instruction, sources);
}
