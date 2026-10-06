import "server-only";

import { z } from "zod";
import {
  assistantToolAllowed,
  assistantToolCatalog,
  assistantToolNames,
  assistantToolPermitted,
  isAssistantToolName,
  isWriteAccess,
} from "@/lib/assistant/catalog";
import { accessTools } from "@/lib/assistant/tools/access";
import { toolFail } from "@/lib/assistant/tools/define";
import { generalTools } from "@/lib/assistant/tools/general";
import { keyTools } from "@/lib/assistant/tools/keys";
import { modelTools } from "@/lib/assistant/tools/models";
import { providerTools } from "@/lib/assistant/tools/providers";
import { settingsTools } from "@/lib/assistant/tools/settings";
import { structureTools } from "@/lib/assistant/tools/structure";
import { usageTools } from "@/lib/assistant/tools/usage";
import type {
  AssistantContext,
  AssistantToolName,
  AssistantToolResult,
  AssistantToolSpec,
  McpToolDef,
} from "@/types/assistant";

const ASSISTANT_TOOLS = {
  ...generalTools,
  ...usageTools,
  ...providerTools,
  ...modelTools,
  ...keyTools,
  ...structureTools,
  ...accessTools,
  ...settingsTools,
} satisfies Record<AssistantToolName, AssistantToolSpec>;

function inputSchema(spec: AssistantToolSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = { ...z.toJSONSchema(spec.input, { io: "input" }) };
  delete schema.$schema;
  return schema;
}

export function isWriteTool(name: string): boolean {
  return isAssistantToolName(name) && isWriteAccess(assistantToolCatalog[name].access);
}

let definitions: McpToolDef[] | null = null;

export function listMcpTools(): McpToolDef[] {
  definitions ??= assistantToolNames.map((name) => ({
    name,
    description: ASSISTANT_TOOLS[name].description,
    inputSchema: inputSchema(ASSISTANT_TOOLS[name]),
  }));
  return definitions;
}

export function mcpToolsForModel(ctx?: AssistantContext) {
  return listMcpTools()
    .filter((tool) => !ctx || assistantToolAllowed(tool.name, ctx))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AssistantContext,
): Promise<AssistantToolResult> {
  if (!isAssistantToolName(name)) return toolFail("unknown_tool");
  if (ctx.disabledTools.includes(name)) return toolFail("tool_disabled");
  if (!assistantToolPermitted(name, ctx)) return toolFail("forbidden");
  if (!assistantToolAllowed(name, ctx)) return toolFail("read_only");
  return ASSISTANT_TOOLS[name].call(args, ctx);
}
