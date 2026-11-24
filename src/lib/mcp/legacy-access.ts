import { MCP_ACTIONS } from "@/schemas/mcp";
import { cleanGrant, levelIncludes } from "@/lib/mcp/resolve";
import type { McpAccessGrant, McpAccessLevel, McpToolAction, McpToolSpec } from "@/types/mcp";

export type LegacyRole = {
  allActions: boolean;
  actions: string[];
  tools: string[];
  deniedTools: string[];
};

export type LegacyRule = {
  mode: string;
  blockedTools: string[];
  blockedActions: string[];
  role: LegacyRole | null;
};

export type LegacyColumns = {
  mode: "allow" | "block";
  blockedActions: McpToolAction[];
  roleId: null;
};

const LEVEL_BLOCKED_ACTIONS: Record<McpAccessLevel, McpToolAction[]> = {
  none: [],
  read: ["write", "delete"],
  write: ["delete"],
  all: [],
};

function legacyRoleAllows(role: LegacyRole | null, tool: McpToolSpec): boolean {
  if (!role) return true;
  if (role.deniedTools.includes(tool.name)) return false;
  if (role.tools.includes(tool.name)) return true;
  if (role.allActions) return true;
  return Boolean(tool.action && role.actions.includes(tool.action));
}

function intendedLevel(rule: LegacyRule): McpAccessLevel {
  const granted = new Set<string>(!rule.role || rule.role.allActions ? MCP_ACTIONS : rule.role.actions);
  for (const action of rule.blockedActions) granted.delete(action);
  const everything = !rule.role || rule.role.allActions;
  if (everything && MCP_ACTIONS.every((action) => granted.has(action))) return "all";
  if (granted.has("read") && granted.has("write")) return "write";
  if (granted.has("read")) return "read";
  return "none";
}

export function legacyGrant(rule: LegacyRule, tools: McpToolSpec[]): McpAccessGrant | null {
  const blockedActions = new Set(rule.blockedActions);
  const byAction = tools.filter((tool) => tool.action && blockedActions.has(tool.action)).map((tool) => tool.name);
  if (rule.mode !== "allow") {
    if (!rule.blockedTools.length && !rule.blockedActions.length) return { access: "none", extraTools: [], blockedTools: [] };
    return cleanGrant({ access: "inherit", extraTools: [], blockedTools: [...rule.blockedTools, ...byAction] });
  }
  const hidden = new Set([...rule.blockedTools, ...byAction]);
  const reached = new Set(tools.filter((tool) => legacyRoleAllows(rule.role, tool) && !hidden.has(tool.name)).map((tool) => tool.name));
  const level = intendedLevel(rule);
  const extraTools = tools.filter((tool) => reached.has(tool.name) && !levelIncludes(level, tool)).map((tool) => tool.name);
  const blockedTools = tools.filter((tool) => !reached.has(tool.name) && levelIncludes(level, tool)).map((tool) => tool.name);
  const known = new Set(tools.map((tool) => tool.name));
  const unknownHidden = rule.blockedTools.filter((name) => !known.has(name));
  return cleanGrant({ access: level, extraTools, blockedTools: [...blockedTools, ...unknownHidden] });
}

export function legacyColumns(grant: McpAccessGrant): LegacyColumns {
  if (grant.access === "none" || grant.access === "inherit") return { mode: "block", blockedActions: [], roleId: null };
  return { mode: "allow", blockedActions: LEVEL_BLOCKED_ACTIONS[grant.access], roleId: null };
}
