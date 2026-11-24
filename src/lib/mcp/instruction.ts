import { withChatInstruction, withMessagesInstruction } from "@/lib/gateway/protocols/leading-system";
import { HUB_TOOL_PREFIX } from "@/lib/mcp/tool-names";
import type { JsonMap } from "@/types/gateway";
import type { McpToolset } from "@/types/mcp";

const MAX_LISTED_SERVERS = 12;

function serverList(toolset: McpToolset): string {
  const counts = new Map<string, number>();
  for (const bound of toolset.tools) counts.set(bound.serverName, (counts.get(bound.serverName) ?? 0) + 1);
  const listed = [...counts.entries()].slice(0, MAX_LISTED_SERVERS).map(([name, count]) => `${name} (${count})`);
  const more = counts.size - listed.length;
  return more > 0 ? `${listed.join(", ")}, and ${more} more` : listed.join(", ");
}

export function hubToolsInstruction(toolset: McpToolset): string {
  return [
    `Tools from the gateway: this conversation runs through an LLM gateway that adds its own MCP tools, named ${HUB_TOOL_PREFIX}<server>__<tool>, from these MCP servers: ${serverList(toolset)}.`,
    "When the user asks which MCP servers or tools you have, name these too, as MCP tools provided by the gateway.",
    "The gateway runs these tools itself and gives you their results in this same turn, so they work even though the user's app may not list or mention them.",
    "They are fully loaded: call them directly. Do not look them up with a tool search or a deferred-tool loader, and do not ask the user to install, connect, enable, or approve them.",
    "They are separate from the app's own tools and MCP servers, even when names look alike. Use the app's tools for the app's work, and use a gateway tool whenever it fits the request instead of saying that you have no access.",
    `Call ${HUB_TOOL_PREFIX} tools in a response without other tool calls; call the app's tools in a later response.`,
  ].join(" ");
}

export function withChatHubInstruction(body: JsonMap, toolset: McpToolset): JsonMap {
  return withChatInstruction(body, hubToolsInstruction(toolset));
}

export function withMessagesHubInstruction(body: JsonMap, toolset: McpToolset): JsonMap {
  return withMessagesInstruction(body, hubToolsInstruction(toolset));
}
