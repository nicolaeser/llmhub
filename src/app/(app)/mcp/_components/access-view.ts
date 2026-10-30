import type { McpAssignmentView, McpChain, McpTargetOption, McpTargetOptions } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";

export const EMPTY_TARGETS: McpTargetOptions = { org: [], team: [], project: [], member: [], key: [] };

export function ruleKey(rule: Pick<McpAssignmentView, "scope" | "id">): string {
  return `${rule.scope}:${rule.id}`;
}

export function chainFor(scope: AssignmentScope, option: McpTargetOption): McpChain {
  return {
    orgId: scope === "org" ? option.id : option.orgId,
    teamId: scope === "team" ? option.id : option.teamId,
    projectId: scope === "project" ? option.id : option.projectId,
    memberId: scope === "member" ? option.id : option.memberId,
    keyId: scope === "key" ? option.id : "",
  };
}

export function blocksServer(rule: McpAssignmentView): boolean {
  return rule.mode === "block" && rule.blockedTools.length === 0 && rule.blockedActions.length === 0;
}

export function ancestorRules(rule: McpAssignmentView, rules: readonly McpAssignmentView[], options: McpTargetOptions): McpAssignmentView[] {
  const option = options[rule.scope].find((item) => item.id === rule.id);
  if (!option) return [];
  const chain = chainFor(rule.scope, option);
  const levels: [AssignmentScope, string][] = [
    ["org", chain.orgId],
    ["team", chain.teamId],
    ["project", chain.projectId],
    ["member", chain.memberId],
  ];
  return levels.flatMap(([scope, id]) => {
    if (!id || (scope === rule.scope && id === rule.id)) return [];
    const match = rules.find((item) => item.scope === scope && item.id === id);
    return match ? [match] : [];
  });
}

export function newRule(scope: AssignmentScope, option: McpTargetOption, mode: McpAssignmentView["mode"]): McpAssignmentView {
  return { scope, id: option.id, label: option.label, mode, blockedTools: [], blockedActions: [], roleId: "", role: null };
}
