import { createHash } from "node:crypto";
import type { McpBoundTool, McpEffectiveServer } from "@/types/mcp";

export const MCP_TOOL_PREFIX = "mcp__";
export const MAX_TOOL_NAME_LENGTH = 64;
export const MAX_MCP_TOOLS = 128;

const SERVER_PART = 24;

function slug(text: string, max: number): string {
  const cleaned = text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return (cleaned || "x").slice(0, max);
}

function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 8);
}

export function isMcpToolName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(MCP_TOOL_PREFIX);
}

export function mcpToolName(server: string, tool: string): string {
  const toolPart = slug(tool, MAX_TOOL_NAME_LENGTH);
  const base = `${MCP_TOOL_PREFIX}${slug(server, SERVER_PART)}__${toolPart}`;
  if (base.length <= MAX_TOOL_NAME_LENGTH && toolPart === tool) return base;
  return `${base.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${shortHash(server, tool)}`;
}

export function bindTools(servers: McpEffectiveServer[], reserved: Iterable<string> = []): McpBoundTool[] {
  const taken = new Set(reserved);
  const out: McpBoundTool[] = [];
  for (const server of servers) {
    for (const tool of server.tools) {
      if (out.length >= MAX_MCP_TOOLS) return out;
      let name = mcpToolName(server.serverName, tool.name);
      if (taken.has(name)) name = `${name.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${shortHash(server.serverId, tool.name)}`;
      if (taken.has(name)) continue;
      taken.add(name);
      out.push({ name, serverId: server.serverId, serverName: server.serverName, tool });
    }
  }
  return out;
}
