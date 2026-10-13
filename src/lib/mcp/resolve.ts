import type { Principal } from "@/types/gateway";
import type {
  McpAssignmentRule,
  McpAssignmentView,
  McpChain,
  McpEffectiveServer,
  McpExplanation,
  McpServerPolicy,
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

function blocksServer(rule: McpAssignmentRule): boolean {
  return rule.mode === "block" && rule.blockedTools.length === 0;
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
    if (!granted || matching.some(blocksServer)) continue;
    const blocked = new Set(matching.flatMap((rule) => rule.blockedTools));
    const tools = allowedTools(server).filter((tool) => !blocked.has(tool.name));
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
  const blockedBy = matching.filter((view) => view.mode === "block" && view.blockedTools.length === 0);
  const blockedTools = [...new Set(matching.flatMap((view) => view.blockedTools))];
  const granted = server.global || grantedBy.length > 0;
  const state = blockedBy.length ? "blocked" : granted ? "granted" : "none";
  const listed = server.toolsRestricted
    ? server.tools.filter((tool) => server.allowedTools.includes(tool.name))
    : server.tools;
  const tools = state === "granted" ? listed.map((tool) => tool.name).filter((name) => !blockedTools.includes(name)) : [];
  return { state, grantedBy, blockedBy, global: server.global, blockedTools, tools };
}
