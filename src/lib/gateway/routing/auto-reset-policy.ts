import {
  AUTO_RESET_PERCENT_DEFAULT,
  AUTO_RESET_PERCENT_MAX,
  AUTO_RESET_PERCENT_MIN,
  AUTO_RESET_SCOPES,
  DEFAULT_AUTO_RESET_SCOPE,
  RESET_KINDS,
} from "@/schemas/resets";
import type { AutoResetPolicies, AutoResetPolicy, ResetKind } from "@/types/resets";

type PolicyColumns = {
  autoReset?: boolean;
  autoResetPercent?: number;
  autoResetScope?: string;
};

export function isResetKind(kind: string): kind is ResetKind {
  return RESET_KINDS.some((item) => item === kind);
}

export function autoResetPolicy(row: PolicyColumns): AutoResetPolicy {
  const percent = row.autoResetPercent;
  return {
    enabled: row.autoReset === true,
    percent:
      typeof percent === "number" && Number.isInteger(percent)
        ? Math.min(AUTO_RESET_PERCENT_MAX, Math.max(AUTO_RESET_PERCENT_MIN, percent))
        : AUTO_RESET_PERCENT_DEFAULT,
    scope: AUTO_RESET_SCOPES.find((scope) => scope === row.autoResetScope) ?? DEFAULT_AUTO_RESET_SCOPE,
  };
}

export function autoResetPoliciesOf(rows: (PolicyColumns & { kind: string })[]): AutoResetPolicies {
  const policies: AutoResetPolicies = {};
  for (const row of rows) {
    if (isResetKind(row.kind)) policies[row.kind] = autoResetPolicy(row);
  }
  return policies;
}
