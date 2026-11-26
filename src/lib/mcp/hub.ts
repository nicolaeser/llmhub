import "server-only";
import { logger } from "@/lib/logging/logger";
import { INVALID_PARAMS, McpEndpointError, type McpEndpointTools } from "@/lib/mcp/endpoint";
import { mcpErrorCode } from "@/lib/mcp/errors";
import { chainOf } from "@/lib/mcp/resolve";
import { bindTools } from "@/lib/mcp/tool-names";
import { createExecutor, loadMcpServers, rememberConnection } from "@/lib/mcp/toolset";
import { guardedFetch } from "@/lib/mcp/transport";
import type { JsonMap, Principal } from "@/types/gateway";
import type { McpBoundTool } from "@/types/mcp";

export const HUB_MCP_INFO = { name: "llmhub", version: "1.0.0" };

function toolCard(tool: McpBoundTool): JsonMap {
  const action = tool.tool.action;
  const annotations: JsonMap = {};
  if (action === "read") annotations.readOnlyHint = true;
  if (action === "write") Object.assign(annotations, { readOnlyHint: false, destructiveHint: false });
  if (action === "delete") Object.assign(annotations, { readOnlyHint: false, destructiveHint: true });
  return {
    name: tool.name,
    ...(tool.tool.title ? { title: tool.tool.title } : {}),
    ...(tool.tool.description ? { description: tool.tool.description } : {}),
    inputSchema: tool.tool.inputSchema,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}

async function boundTools(principal: Principal) {
  const { servers, records } = await loadMcpServers(chainOf(principal));
  return { tools: bindTools(servers), records };
}

export function hubMcpTools(principal: Principal): McpEndpointTools {
  return {
    info: HUB_MCP_INFO,
    async list() {
      return (await boundTools(principal)).tools.map(toolCard);
    },
    async call(name, args, signal) {
      const { tools, records } = await boundTools(principal);
      const bound = tools.find((tool) => tool.name === name);
      if (!bound) throw new McpEndpointError(INVALID_PARAMS, `Unknown tool: ${name}`);
      const executor = createExecutor(records, guardedFetch, rememberConnection, principal);
      const started = Date.now();
      const trace = { serverId: bound.serverId, tool: bound.tool.name };
      try {
        const outcome = await executor.call(bound, args, AbortSignal.any([signal, AbortSignal.timeout(executor.timeoutMs(bound))]));
        logger.info("mcp.tool_call", { ...trace, ms: Date.now() - started, ok: !outcome.isError });
        return { content: [{ type: "text", text: outcome.text }], isError: outcome.isError };
      } catch (err) {
        const code = mcpErrorCode(err);
        logger.warn("mcp.tool_call", { ...trace, ms: Date.now() - started, ok: false, code });
        return { content: [{ type: "text", text: `The tool call failed (${code}).` }], isError: true };
      } finally {
        await executor.close();
      }
    },
  };
}
