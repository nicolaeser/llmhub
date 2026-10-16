import { MCP_ACTIONS } from "@/schemas/mcp";
import type { Principal } from "@/types/gateway";
import type {
  McpAssignmentRule,
  McpAssignmentView,
  McpChain,
  McpEffectiveServer,
  McpExplanation,
  McpRoleGrant,
  McpServerPolicy,
  McpToolAction,
  McpToolActions,
  McpToolGrant,
  McpToolSpec,
} from "@/types/mcp";

const CHAIN_COLUMNS = [
  ["orgId", "org"],
  ["teamId", "team"],
  ["projectId", "project"],
  ["memberId", "member"],
  ["keyId", "key"],
] as const;

export function chainOf(principal: Principal): McpChain {
  return {
    orgId: principal.orgId,
    teamId: principal.teamId,
    projectId: principal.key?.project_id ?? "",
    memberId: principal.memberId,
    keyId: principal.key?.token_id ?? "",
  };
}

export function chainIsEmpty(chain: McpChain): boolean {
  return CHAIN_COLUMNS.every(([column]) => !chain[column]);
}

export function inChain(rule: Pick<McpAssignmentRule, (typeof CHAIN_COLUMNS)[number][0]>, chain: McpChain): boolean {
  return CHAIN_COLUMNS.some(([column]) => Boolean(rule[column]) && rule[column] === chain[column]);
}

function deniesServer(rule: Pick<McpAssignmentRule, "mode" | "blockedTools" | "blockedActions">): boolean {
  return rule.mode === "block" && rule.blockedTools.length === 0 && rule.blockedActions.length === 0;
}

function actionBlocked(tool: McpToolSpec, blocked: ReadonlySet<string>): boolean {
  return Boolean(tool.action && blocked.has(tool.action));
}

const SCOPE_RANK = ["key", "member", "project", "team", "org"] as const;

function columnScope(rule: {
  keyId?: string | null;
  memberId?: string | null;
  projectId?: string | null;
  teamId?: string | null;
  orgId?: string | null;
}): (typeof SCOPE_RANK)[number] | null {
  if (rule.keyId) return "key";
  if (rule.memberId) return "member";
  if (rule.projectId) return "project";
  if (rule.teamId) return "team";
  if (rule.orgId) return "org";
  return null;
}

function mostSpecificAllow<T extends { mode: string; scope?: string; keyId?: string | null; memberId?: string | null; projectId?: string | null; teamId?: string | null; orgId?: string | null }>(
  rules: T[],
): T | null {
  let best: T | null = null;
  let rank: number = SCOPE_RANK.length;
  for (const rule of rules) {
    if (rule.mode !== "allow") continue;
    const scope = rule.scope && SCOPE_RANK.includes(rule.scope as (typeof SCOPE_RANK)[number])
      ? (rule.scope as (typeof SCOPE_RANK)[number])
      : columnScope(rule);
    const next = scope ? SCOPE_RANK.indexOf(scope) : SCOPE_RANK.length;
    if (next < rank) {
      best = rule;
      rank = next;
    }
  }
  return best;
}

export function isToolAction(value: unknown): value is McpToolAction {
  return typeof value === "string" && (MCP_ACTIONS as readonly string[]).includes(value);
}

export function toolActionsOf(raw: unknown): McpToolActions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, McpToolAction] => isToolAction(entry[1])));
}

export function classifyTools(tools: McpToolSpec[], actions: McpToolActions): McpToolSpec[] {
  return tools.map((tool) => {
    const action = actions[tool.name];
    return action ? { ...tool, action } : tool;
  });
}

export function toolGrant(role: Pick<McpRoleGrant, "tools" | "deniedTools">, name: string): McpToolGrant {
  if (role.deniedTools.includes(name)) return "deny";
  if (role.tools.includes(name)) return "allow";
  return "inherit";
}

export function roleAllowsTool(role: McpRoleGrant | null | undefined, tool: McpToolSpec): boolean {
  if (!role) return true;
  const grant = toolGrant(role, tool.name);
  if (grant !== "inherit") return grant === "allow";
  if (role.allActions) return true;
  return Boolean(tool.action && role.actions.includes(tool.action));
}

function allowedTools(server: McpServerPolicy): McpToolSpec[] {
  if (!server.toolsRestricted) return server.tools;
  const allowed = new Set(server.allowedTools);
  return server.tools.filter((tool) => allowed.has(tool.name));
}

export function effectiveServers(
  servers: McpServerPolicy[],
  rules: McpAssignmentRule[],
  chain: McpChain,
): McpEffectiveServer[] {
  const out: McpEffectiveServer[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    const matching = rules.filter((rule) => rule.serverId === server.id && inChain(rule, chain));
    const granted = server.global || matching.some((rule) => rule.mode === "allow");
    if (!granted || matching.some(deniesServer)) continue;
    const blocked = new Set(matching.flatMap((rule) => rule.blockedTools));
    const blockedActions = new Set(matching.flatMap((rule) => rule.blockedActions));
    const role = mostSpecificAllow(matching)?.role;
    const tools = allowedTools(server).filter(
      (tool) => roleAllowsTool(role, tool) && !blocked.has(tool.name) && !actionBlocked(tool, blockedActions),
    );
    if (tools.length) out.push({ serverId: server.id, serverName: server.name, tools });
  }
  return out;
}

function chainMatch(view: McpAssignmentView, chain: McpChain): boolean {
  const column = CHAIN_COLUMNS.find(([, scope]) => scope === view.scope)?.[0];
  return Boolean(column && chain[column] && chain[column] === view.id);
}

export function explainAccess(
  server: Pick<McpServerPolicy, "global" | "toolsRestricted" | "allowedTools" | "tools">,
  assignments: McpAssignmentView[],
  chain: McpChain,
): McpExplanation {
  const matching = assignments.filter((view) => chainMatch(view, chain));
  const grantedBy = matching.filter((view) => view.mode === "allow");
  const blockedBy = matching.filter(deniesServer);
  const blockedTools = [...new Set(matching.flatMap((view) => view.blockedTools))];
  const blockedActions = [...new Set(matching.flatMap((view) => view.blockedActions))];
  const granted = server.global || grantedBy.length > 0;
  const state = blockedBy.length ? "blocked" : granted ? "granted" : "none";
  const listed = server.toolsRestricted
    ? server.tools.filter((tool) => server.allowedTools.includes(tool.name))
    : server.tools;
  const hidden = new Set(blockedActions);
  const role = mostSpecificAllow(matching)?.role;
  const tools =
    state === "granted"
      ? listed
          .filter((tool) => roleAllowsTool(role, tool) && !blockedTools.includes(tool.name) && !actionBlocked(tool, hidden))
          .map((tool) => tool.name)
      : [];
  return { state, grantedBy, blockedBy, global: server.global, blockedTools, blockedActions, tools };
}
