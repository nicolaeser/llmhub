import "server-only";
import { asRecord } from "@/lib/gateway/core";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp/client";
import { chainOf } from "@/lib/mcp/resolve";
import { bindTools } from "@/lib/mcp/tool-names";
import { createExecutor, loadMcpServers } from "@/lib/mcp/toolset";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { JsonMap, Principal } from "@/types/gateway";
import type { McpBoundTool } from "@/types/mcp";

const PROTOCOL_HEADER = { "mcp-protocol-version": MCP_PROTOCOL_VERSION };

function rpc(id: unknown, result: JsonMap): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: PROTOCOL_HEADER });
}

function fail(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { headers: PROTOCOL_HEADER });
}

function argumentsOf(value: unknown): JsonMap {
  if (typeof value === "string") return asRecord(parseJsonOrNull(value)) ?? {};
  return asRecord(value) ?? {};
}

function toolCard(tool: McpBoundTool): JsonMap {
  const action = tool.tool.action;
  const annotations: JsonMap = {};
  if (action === "read") annotations.readOnlyHint = true;
  if (action === "write") annotations.readOnlyHint = false;
  if (action === "delete") annotations.destructiveHint = true;
  return {
    name: tool.name,
    ...(tool.tool.title ? { title: tool.tool.title } : {}),
    ...(tool.tool.description ? { description: tool.tool.description } : {}),
    inputSchema: tool.tool.inputSchema,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}

export async function handleHubMcp(principal: Principal, body: unknown): Promise<Response> {
  const message = asRecord(body);
  if (!message || typeof message.method !== "string") return fail(null, -32600, "Invalid Request");
  if (message.id === undefined) return new Response(null, { status: 202, headers: PROTOCOL_HEADER });
  const id = message.id;
  const params = asRecord(message.params) ?? {};
  if (message.method === "ping") return rpc(id, {});
  if (message.method === "initialize") {
    return rpc(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "llmhub", version: "1.0.0" },
    });
  }
  if (message.method !== "tools/list" && message.method !== "tools/call") return fail(id, -32601, "Method not found");
  const { servers, records } = await loadMcpServers(chainOf(principal));
  const tools = bindTools(servers);
  const executor = createExecutor(records);
  try {
    if (message.method === "tools/list") return rpc(id, { tools: tools.map(toolCard) });
    const name = typeof params.name === "string" ? params.name : "";
    const bound = tools.find((tool) => tool.name === name);
    if (!bound) return rpc(id, { content: [{ type: "text", text: "Unknown tool." }], isError: true });
    const outcome = await executor.call(bound, argumentsOf(params.arguments), AbortSignal.timeout(30_000));
    return rpc(id, { content: [{ type: "text", text: outcome.text }], isError: outcome.isError });
  } finally {
    await executor.close();
  }
}
