import type { Principal } from "@/types/gateway";
import type { AccountAccess, AccountStrategy, AssignmentRow, AssignmentScope } from "@/types/providers";

export const ASSIGNMENT_SCOPES = ["org", "team", "project", "member", "key"] as const satisfies readonly AssignmentScope[];

export const ACCOUNT_STRATEGIES = [
  "inherit",
  "smart",
  "quota_balanced",
  "quota_expiring",
  "round_robin",
  "priority",
  "least_inflight",
] as const satisfies readonly AccountStrategy[];

export const DEFAULT_ACCOUNT_STRATEGY: AccountStrategy = "inherit";

export function isAccountStrategy(value: string): value is AccountStrategy {
  return (ACCOUNT_STRATEGIES as readonly string[]).includes(value);
}

export function isAssignmentScope(value: string): value is AssignmentScope {
  return (ASSIGNMENT_SCOPES as readonly string[]).includes(value);
}

export function accessOf(principal: Principal | undefined): AccountAccess | null {
  const key = principal?.key;
  if (!principal || !key) return null;
  return {
    orgId: principal.orgId,
    teamId: principal.teamId,
    projectId: key.project_id,
    memberId: principal.memberId,
    keyId: key.token_id,
  };
}

function same(assigned: string | null, actual: string): boolean {
  return Boolean(assigned) && assigned === actual;
}

export function accountAllowed(
  provider: { restricted: boolean; assignments: AssignmentRow[] } | null | undefined,
  access: AccountAccess | null,
): boolean {
  if (!provider?.restricted) return true;
  if (!access) return false;
  return provider.assignments.some(
    (row) =>
      same(row.keyId, access.keyId) ||
      same(row.memberId, access.memberId) ||
      same(row.projectId, access.projectId) ||
      same(row.teamId, access.teamId) ||
      same(row.orgId, access.orgId),
  );
}
