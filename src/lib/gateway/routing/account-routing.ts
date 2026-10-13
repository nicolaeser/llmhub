import "server-only";
import prisma from "@/lib/db/prisma";
import { DEFAULT_ACCOUNT_STRATEGY, isAccountStrategy } from "@/lib/gateway/routing/account-access";
import type { AccountStrategy } from "@/types/providers";

const TTL_MS = 5_000;

let cached: { at: number; policies: Map<string, AccountStrategy> } | null = null;

export async function accountPolicies(now = Date.now()): Promise<Map<string, AccountStrategy>> {
  if (cached && now - cached.at < TTL_MS) return cached.policies;
  const rows = await prisma.accountRouting.findMany();
  const policies = new Map<string, AccountStrategy>(
    rows.map((row) => [row.kind, isAccountStrategy(row.strategy) ? row.strategy : DEFAULT_ACCOUNT_STRATEGY]),
  );
  cached = { at: now, policies };
  return policies;
}

export function forgetAccountPolicies(): void {
  cached = null;
}
