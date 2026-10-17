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
import { docsLink, fetchDocs } from "@/lib/mcp/docs-source";
import { BUILDER_SYSTEM, PICK_SYSTEM, continuePrompt, mergeTools, readDraft, readPick, templateAllows } from "@/lib/mcp/hosted";
import { importOpenApi, readApiDocument } from "@/lib/mcp/openapi";
import { guardedFetch } from "@/lib/mcp/transport";
import { modelRole } from "@/lib/models/model-role";
import { BUILDER_MODEL_KEY, MAX_HOSTED_TOOLS, builderDraftSchema, builderModelSchema } from "@/schemas/mcp";
import type { JsonMap } from "@/types/gateway";
import type { HostedTool, McpBuilderModel, McpBuilderTemplate, McpDraft } from "@/types/mcp";

const DRAFT_MAX_TOKENS = 16_000;
const MAX_DRAFT_ROUNDS = 3;
const MAX_MODEL_DOCS = 200_000;

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

async function linkedDocs(link: string): Promise<string> {
  try {
    return await fetchDocs(link, guardedFetch(false));
  } catch (err) {
    const code = err instanceof Error && /^MCP_[A-Z_]+$/.test(err.message) ? err.message : "MCP_BUILDER_FETCH";
    throw new Error(code, { cause: err });
  }
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

async function draftFromSpec(template: McpBuilderTemplate, instruction: string, document: JsonMap): Promise<McpDraft> {
  const imported = importOpenApi(document);
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
  };
}

async function draftFromModel(instruction: string, docs: string): Promise<McpDraft> {
  if (docs.length > MAX_MODEL_DOCS) throw new Error("MCP_BUILDER_DOCS_LONG");
  const alias = await builderAlias();
  if (!alias) throw new Error("MCP_BUILDER_MODEL");
  const request = `Request:\n${instruction}\n\nAPI documentation:\n${docs}`;
  let answer: { text: string; cut: boolean };
  try {
    answer = await complete(alias, [
      { role: "system", content: BUILDER_SYSTEM },
      { role: "user", content: request },
    ]);
  } catch (err) {
    if (err instanceof Error && err.message === "MCP_BUILDER_MODEL") throw err;
    throw new Error("MCP_BUILDER_DRAFT", { cause: err });
  }
  const first = readDraft(answer.text);
  if (!first.server) throw new Error("MCP_BUILDER_DRAFT");
  let tools = first.tools;
  let cut = answer.cut || first.cut;
  for (let round = 1; cut && round < MAX_DRAFT_ROUNDS && tools.length < MAX_HOSTED_TOOLS; round += 1) {
    let more: { text: string; cut: boolean };
    try {
      more = await complete(alias, [
        { role: "system", content: BUILDER_SYSTEM },
        { role: "user", content: `${request}\n\n${continuePrompt(tools.map((tool) => tool.name))}` },
      ]);
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
  };
}

export async function draftMcpServer(raw: unknown): Promise<McpDraft> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(builderDraftSchema, raw);
  const link = docsLink(input.docs);
  const docs = link ? await linkedDocs(link) : input.docs;
  const document = readApiDocument(docs);
  if (document) return draftFromSpec(input.template, input.instruction, document);
  return draftFromModel(input.instruction, docs);
}
