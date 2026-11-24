import { MCP_ACCESS_LEVELS, MCP_ACTIONS, MCP_RULE_ACCESS } from "@/schemas/mcp";
import type { Principal } from "@/types/gateway";
import type {
  McpAccessGrant,
  McpAccessLevel,
  McpAccessSource,
  McpAssignmentRule,
  McpAssignmentView,
  McpCeiling,
  McpChain,
  McpEffectiveServer,
  McpExplanation,
  McpRuleAccess,
  McpServerPolicy,
  McpToolAction,
  McpToolActions,
  McpToolSpec,
} from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";

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

const LEVEL_ACTIONS: Record<Exclude<McpAccessLevel, "all">, readonly McpToolAction[]> = {
  none: [],
  read: ["read"],
  write: ["read", "write"],
};

const SCOPE_ORDER: readonly AssignmentScope[] = ["org", "team", "project", "member", "key"];

export function isAccessLevel(value: unknown): value is McpAccessLevel {
  return typeof value === "string" && (MCP_ACCESS_LEVELS as readonly string[]).includes(value);
}

export function isRuleAccess(value: unknown): value is McpRuleAccess {
  return typeof value === "string" && (MCP_RULE_ACCESS as readonly string[]).includes(value);
}

export function ruleAccessOf(value: string): McpRuleAccess {
  return isRuleAccess(value) ? value : "inherit";
}

export function defaultAccessOf(server: { global: boolean; globalAccess: string }): McpAccessLevel {
  if (!server.global) return "none";
  return isAccessLevel(server.globalAccess) && server.globalAccess !== "none" ? server.globalAccess : "all";
}

export function levelRank(level: McpAccessLevel): number {
  return MCP_ACCESS_LEVELS.indexOf(level);
}

export function levelIncludes(level: McpAccessLevel, tool: Pick<McpToolSpec, "action">): boolean {
  if (level === "all") return true;
  return Boolean(tool.action && LEVEL_ACTIONS[level].includes(tool.action));
}

export function grantAllows(grant: McpAccessGrant, tool: Pick<McpToolSpec, "name" | "action">): boolean {
  if (grant.blockedTools.includes(tool.name)) return false;
  if (grant.access === "inherit") return true;
  return levelIncludes(grant.access, tool) || grant.extraTools.includes(tool.name);
}

export function withToolVisible(
  grant: McpAccessGrant,
  tool: Pick<McpToolSpec, "name" | "action">,
  visible: boolean,
): Pick<McpAccessGrant, "extraTools" | "blockedTools"> {
  const extraTools = grant.extraTools.filter((name) => name !== tool.name);
  const blockedTools = grant.blockedTools.filter((name) => name !== tool.name);
  const covered = grant.access === "inherit" || levelIncludes(grant.access, tool);
  if (visible && !covered) extraTools.push(tool.name);
  if (!visible && covered) blockedTools.push(tool.name);
  return { extraTools, blockedTools };
}

export function cleanGrant(grant: McpAccessGrant, known?: ReadonlySet<string>): McpAccessGrant | null {
  const keep = (names: string[]) => [...new Set(names)].filter((name) => !known || known.has(name));
  const blockedTools = grant.access === "none" ? [] : keep(grant.blockedTools);
  const extraTools = grant.access === "inherit" || grant.access === "all" ? [] : keep(grant.extraTools).filter((name) => !blockedTools.includes(name));
  if (grant.access === "inherit" && !blockedTools.length) return null;
  return { access: grant.access, extraTools, blockedTools };
}

function catalogOf(server: Pick<McpServerPolicy, "toolsRestricted" | "allowedTools" | "tools">): McpToolSpec[] {
  if (!server.toolsRestricted) return server.tools;
  const allowed = new Set(server.allowedTools);
  return server.tools.filter((tool) => allowed.has(tool.name));
}

function scopeRank(scope: AssignmentScope): number {
  return SCOPE_ORDER.indexOf(scope);
}

type Resolved<T> = {
  state: McpExplanation["state"];
  level: McpAccessLevel;
  limitedBy: T | "default" | null;
  usesDefault: boolean;
  tools: McpToolSpec[];
};

type GrantPolicy = Pick<McpServerPolicy, "defaultAccess" | "toolsRestricted" | "allowedTools" | "tools">;

function resolveGrants<T extends McpAccessGrant>(server: GrantPolicy, rules: readonly T[]): Resolved<T> {
  const levelled = rules.filter((rule) => rule.access !== "inherit");
  const usesDefault = levelled.length === 0;
  if (usesDefault && server.defaultAccess === "none") {
    return { state: "none", level: "none", limitedBy: null, usesDefault, tools: [] };
  }
  const blocking = levelled.find((rule) => rule.access === "none" && rule.extraTools.length === 0);
  if (blocking) return { state: "blocked", level: "none", limitedBy: blocking, usesDefault, tools: [] };
  let level: McpAccessLevel = usesDefault ? server.defaultAccess : "all";
  let limitedBy: T | "default" | null = usesDefault ? "default" : null;
  for (const rule of levelled) {
    if (rule.access === "inherit") continue;
    if (limitedBy === null || levelRank(rule.access) < levelRank(level)) {
      level = rule.access;
      limitedBy = rule;
    }
  }
  const base: McpAccessGrant = { access: usesDefault ? server.defaultAccess : "inherit", extraTools: [], blockedTools: [] };
  const tools = catalogOf(server).filter((tool) => grantAllows(base, tool) && rules.every((rule) => grantAllows(rule, tool)));
  return { state: "granted", level, limitedBy, usesDefault, tools };
}

function sourceOf(limitedBy: McpAssignmentView | "default" | null): McpAccessSource | null {
  if (limitedBy === "default") return { kind: "default" };
  return limitedBy ? { kind: "rule", rule: limitedBy } : null;
}

const COLUMN_SCOPES = [
  ["orgId", "org"],
  ["teamId", "team"],
  ["projectId", "project"],
  ["memberId", "member"],
  ["keyId", "key"],
] as const;

function ruleScope(rule: McpAssignmentRule): AssignmentScope {
  return COLUMN_SCOPES.find(([column]) => Boolean(rule[column]))?.[1] ?? "key";
}

export function effectiveServers(
  servers: McpServerPolicy[],
  rules: McpAssignmentRule[],
  chain: McpChain,
): McpEffectiveServer[] {
  const out: McpEffectiveServer[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    const matching = rules
      .filter((rule) => rule.serverId === server.id && inChain(rule, chain))
      .sort((a, b) => scopeRank(ruleScope(a)) - scopeRank(ruleScope(b)));
    const resolved = resolveGrants(server, matching);
    if (resolved.state === "granted" && resolved.tools.length) {
      out.push({ serverId: server.id, serverName: server.name, tools: resolved.tools });
    }
  }
  return out;
}

function chainMatch(view: McpAssignmentView, chain: McpChain): boolean {
  const column = CHAIN_COLUMNS.find(([, scope]) => scope === view.scope)?.[0];
  return Boolean(column && chain[column] && chain[column] === view.id);
}

export function rulesInChain(assignments: readonly McpAssignmentView[], chain: McpChain): McpAssignmentView[] {
  return assignments
    .filter((view) => chainMatch(view, chain))
    .sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope));
}

export function explainAccess(server: GrantPolicy, assignments: readonly McpAssignmentView[], chain: McpChain): McpExplanation {
  const steps = rulesInChain(assignments, chain);
  const resolved = resolveGrants(server, steps);
  return {
    state: resolved.state,
    level: resolved.level,
    limitedBy: sourceOf(resolved.limitedBy),
    steps,
    usesDefault: resolved.usesDefault,
    tools: resolved.tools.map((tool) => tool.name),
  };
}

export function ceilingOf(server: GrantPolicy, above: readonly McpAssignmentView[]): McpCeiling {
  if (!above.some((rule) => rule.access !== "inherit")) {
    const catalog = new Set(catalogOf(server).map((tool) => tool.name));
    const hidden = new Set(above.flatMap((rule) => rule.blockedTools));
    return { level: null, limitedBy: null, allows: (tool) => catalog.has(tool.name) && !hidden.has(tool.name) };
  }
  const resolved = resolveGrants(server, above);
  const names = new Set(resolved.tools.map((tool) => tool.name));
  return { level: resolved.level, limitedBy: sourceOf(resolved.limitedBy), allows: (tool) => names.has(tool.name) };
}
