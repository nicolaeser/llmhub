import { roleAllowsTool } from "@/lib/mcp/resolve";
import type { McpRoleView, McpToolGrant, McpToolSpec } from "@/types/mcp";

export const NEW_ROLE = "new:";

export function draftOf(role: McpRoleView): McpRoleView {
  return { ...role, actions: [...role.actions], tools: [...role.tools], deniedTools: [...role.deniedTools] };
}

export function toolMatches(tool: McpToolSpec, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return tool.name.toLowerCase().includes(needle) || tool.title.toLowerCase().includes(needle);
}

export function withGrant(role: McpRoleView, name: string, grant: McpToolGrant): Pick<McpRoleView, "tools" | "deniedTools"> {
  return {
    tools: grant === "allow" ? [...role.tools.filter((item) => item !== name), name] : role.tools.filter((item) => item !== name),
    deniedTools:
      grant === "deny"
        ? [...role.deniedTools.filter((item) => item !== name), name]
        : role.deniedTools.filter((item) => item !== name),
  };
}

export function roleReach(role: McpRoleView, tools: readonly McpToolSpec[]): { granted: number; total: number; exceptions: number } {
  return {
    granted: tools.filter((tool) => roleAllowsTool(role, tool)).length,
    total: tools.length,
    exceptions: role.tools.length + role.deniedTools.length,
  };
}
