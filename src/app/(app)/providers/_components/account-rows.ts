import { limitGroups, summaryGroups } from "@/lib/gateway/upstreams/limit-groups";
import type {
  AccountState,
  LimitGroup,
  LimitSnapshot,
  LimitSummary,
  PartialLimits,
  ProviderView,
  SubscriptionLimits,
} from "@/types/providers";
import { accountState, partialLimits, recoveryAt } from "./account-status";

export const ACCOUNT_SUMMARY_SIZE = 3;

export type AccountMenuAction =
  | "details"
  | "refresh"
  | "signIn"
  | "edit"
  | "access"
  | "pause"
  | "resume"
  | "import"
  | "disconnect";

export type AccountRow = {
  state: AccountState;
  title: string;
  subtitle: string | null;
  plan: string;
  sharedVia: string | null;
  manageOff: boolean;
  partial: PartialLimits | null;
  limits: SubscriptionLimits | null;
  groups: LimitGroup[];
  summary: LimitSummary;
  detailed: boolean;
  nextReset: number | null;
  needsSignIn: boolean;
  refreshable: boolean;
  held: boolean;
  failure: string;
  nextCheck: number | null;
  restricted: boolean;
  assignments: number;
};

function soonestReset(groups: LimitGroup[], now: number): number | null {
  const times = groups
    .flatMap((group) => group.members.map((member) => (member.resetsAt ? Date.parse(member.resetsAt) : NaN)))
    .filter((time) => Number.isFinite(time) && time > now);
  return times.length ? Math.min(...times) : null;
}

export function accountRow(
  row: ProviderView,
  entry: LimitSnapshot | undefined,
  reports: boolean,
  now: number,
): AccountRow {
  const state = accountState(row, entry, reports, now);
  const limits = entry?.limits ?? null;
  const groups = limitGroups(row.kind, limits, now);
  const summary = summaryGroups(groups, ACCOUNT_SUMMARY_SIZE);
  const account = row.signIn?.account ?? "";
  const needsSignIn = row.signIn?.status !== "active" || entry?.error === "SIGN_IN_EXPIRED";
  const failure = entry?.error && entry.error !== "SIGN_IN_EXPIRED" ? entry.error : "";
  return {
    state,
    title: account || row.name,
    subtitle: account ? row.name : null,
    plan: limits?.plan || row.signIn?.plan || "",
    sharedVia: row.sharedVia,
    manageOff: row.sharedVia !== null && !row.manageActive,
    partial: state === "available" ? partialLimits(row, entry, now) : null,
    limits,
    groups,
    summary,
    detailed: summary.more > 0 || groups.some((group) => group.members.length > 1),
    nextReset: state === "limited" ? recoveryAt(row, entry, now) : soonestReset(groups, now),
    needsSignIn,
    refreshable: reports && !needsSignIn,
    held: entry?.retryAt ? Date.parse(entry.retryAt) > now : false,
    failure,
    nextCheck: failure && entry?.nextAt ? Math.max(Date.parse(entry.nextAt), now) : null,
    restricted: row.restricted,
    assignments: row.assignments.length,
  };
}

export function accountMenuActions(
  canManage: boolean,
  row: Pick<ProviderView, "enabled">,
  account: Pick<AccountRow, "needsSignIn" | "refreshable">,
): AccountMenuAction[] {
  const readable: AccountMenuAction[] = account.refreshable ? ["details", "refresh"] : ["details"];
  if (!canManage) return readable;
  return [
    ...readable,
    account.needsSignIn ? "signIn" : "edit",
    "access",
    row.enabled ? "pause" : "resume",
    "import",
    "disconnect",
  ];
}

export function accountMatches(row: ProviderView, query: string, labels: string[] = []): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [row.signIn?.account ?? "", row.name, row.signIn?.plan ?? "", row.sharedVia ?? "", ...labels].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}
