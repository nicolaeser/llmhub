import "server-only";
import { pinsAccounts } from "@/lib/gateway/routing/account-affinity";
import type { AccountStep, LogSessionModel, LogSessionRef } from "@/types/logs";

export const ACTIVE_SESSION_MS = 5 * 60_000;

export function sessionKey(ref: LogSessionRef): string {
  return `${ref.sessionId}\u0000${ref.keyId}\u0000${ref.userId}`;
}

export function accountSwitchFlags(steps: AccountStep[]): boolean[] {
  const current = new Map<string, string>();
  return steps.map((step) => {
    if (!step.providerId || !pinsAccounts(step.provider)) return false;
    const previous = current.get(step.provider);
    current.set(step.provider, step.providerId);
    return previous !== undefined && previous !== step.providerId;
  });
}

export function countAccountSwitches(steps: AccountStep[]): number {
  return accountSwitchFlags(steps).filter(Boolean).length;
}

export function countPinnedAccounts(accounts: AccountStep[]): number {
  return new Set(
    accounts
      .filter((account) => account.providerId && pinsAccounts(account.provider))
      .map((account) => `${account.provider}\u0000${account.providerId}`),
  ).size;
}

export function switchesPossible(accounts: AccountStep[]): boolean {
  const seen = new Map<string, string>();
  for (const account of accounts) {
    if (!account.providerId || !pinsAccounts(account.provider)) continue;
    const known = seen.get(account.provider);
    if (known !== undefined && known !== account.providerId) return true;
    seen.set(account.provider, account.providerId);
  }
  return false;
}

export function sessionModels(rows: { model: string; requests: number }[]): LogSessionModel[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.model) counts.set(row.model, (counts.get(row.model) ?? 0) + row.requests);
  }
  return [...counts]
    .map(([model, requests]) => ({ model, requests }))
    .sort((left, right) => right.requests - left.requests || left.model.localeCompare(right.model));
}

export function leadingAgent(rows: { agent: string; requests: number }[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.agent) counts.set(row.agent, (counts.get(row.agent) ?? 0) + row.requests);
  }
  let best = "";
  let most = 0;
  for (const [agent, requests] of counts) {
    if (requests > most || (requests === most && agent < best)) {
      best = agent;
      most = requests;
    }
  }
  return best;
}

export function sessionSpan(first: Date, firstLatencyMs: number, last: Date): { startedAt: Date; durationMs: number } {
  const startedAt = new Date(first.getTime() - Math.max(0, firstLatencyMs));
  return { startedAt, durationMs: Math.max(0, last.getTime() - startedAt.getTime()) };
}
