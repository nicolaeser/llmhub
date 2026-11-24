import type { McpAssignmentView, McpChain, McpRuleAccess, McpTargetOption, McpTargetOptions } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";

export const EMPTY_TARGETS: McpTargetOptions = { org: [], team: [], project: [], member: [], key: [] };

const LEVELS: readonly AssignmentScope[] = ["org", "team", "project", "member", "key"];

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

export function ancestorRules(rule: McpAssignmentView, rules: readonly McpAssignmentView[], options: McpTargetOptions): McpAssignmentView[] {
  const option = options[rule.scope].find((item) => item.id === rule.id);
  if (!option) return [];
  const chain = chainFor(rule.scope, option);
  const ids: Record<AssignmentScope, string> = {
    org: chain.orgId,
    team: chain.teamId,
    project: chain.projectId,
    member: chain.memberId,
    key: chain.keyId,
  };
  return LEVELS.slice(0, LEVELS.indexOf(rule.scope)).flatMap((scope) => {
    const match = ids[scope] ? rules.find((item) => item.scope === scope && item.id === ids[scope]) : undefined;
    return match ? [match] : [];
  });
}

export function newRule(scope: AssignmentScope, option: McpTargetOption, access: McpRuleAccess): McpAssignmentView {
  return { scope, id: option.id, label: option.label, access, extraTools: [], blockedTools: [] };
}
