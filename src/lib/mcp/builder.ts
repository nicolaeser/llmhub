import "server-only";
import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { modelAlias } from "@/lib/gateway/catalog/model-alias";
import { enabledModelChoices } from "@/lib/models/aliases";
import { chatChoices } from "@/lib/models/model-role";
import { asRecord } from "@/lib/gateway/core";
import { chatOnce } from "@/lib/gateway/dispatch/chat";
import { loadGroup } from "@/lib/gateway/routing/runtime";
import { BUILDER_SYSTEM, parseDraft } from "@/lib/mcp/hosted";
import { BUILDER_MODEL_KEY, builderDraftSchema, builderModelSchema } from "@/schemas/mcp";
import type { McpDraft } from "@/types/mcp";

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

export async function setBuilderModel(raw: unknown): Promise<{ model: string }> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const alias = modelAlias(parse(builderModelSchema, raw));
  if (alias) {
    const allowed = chatChoices(await enabledModelChoices());
    if (!allowed.some((choice) => choice.alias === alias)) throw new Error("MCP_BUILDER_MODEL");
  }
  await prisma.setting.upsert({
    where: { key: BUILDER_MODEL_KEY },
    update: { value: alias },
    create: { key: BUILDER_MODEL_KEY, value: alias },
  });
  return { model: alias };
}

export async function draftMcpServer(raw: unknown): Promise<McpDraft> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(builderDraftSchema, raw);
  const setting = await prisma.setting.findUnique({ where: { key: BUILDER_MODEL_KEY } });
  const alias = modelAlias(setting?.value ?? "");
  if (!alias) throw new Error("MCP_BUILDER_MODEL");
  let text: string;
  try {
    const group = await loadGroup(alias);
    const deployment = group.deployments[0];
    if (!deployment) throw new Error("MCP_BUILDER_MODEL");
    const json = await chatOnce(
      deployment,
      group,
      {
        messages: [
          { role: "system", content: BUILDER_SYSTEM },
          { role: "user", content: `Request:\n${input.instruction}\n\nAPI documentation:\n${input.docs}` },
        ],
      },
      alias,
    );
    text = assistantText(json);
  } catch (err) {
    if (err instanceof Error && err.message === "MCP_BUILDER_MODEL") throw err;
    throw new Error("MCP_BUILDER_DRAFT", { cause: err });
  }
  const parsed = parseDraft(text);
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.draft;
}
