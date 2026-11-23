import "server-only";
import prisma from "@/lib/db/prisma";
import { DEFAULT_ACCOUNT_STRATEGY, isAccountStrategy } from "@/lib/gateway/routing/account-access";
import { autoResetPoliciesOf } from "@/lib/gateway/routing/auto-reset-policy";
import type { AccountStrategy } from "@/types/providers";
import type { AutoResetPolicies } from "@/types/resets";

const TTL_MS = 5_000;

let cached: {
  at: number;
  policies: Map<string, AccountStrategy>;
  resets: AutoResetPolicies;
  apiFallback: ReadonlySet<string>;
  keyConcurrency: ReadonlyMap<string, number>;
} | null = null;

async function routingState(now: number) {
  if (cached && now - cached.at < TTL_MS) return cached;
  const rows = await prisma.accountRouting.findMany();
  cached = {
    at: now,
    policies: new Map<string, AccountStrategy>(
      rows.map((row) => [row.kind, isAccountStrategy(row.strategy) ? row.strategy : DEFAULT_ACCOUNT_STRATEGY]),
    ),
    resets: autoResetPoliciesOf(rows),
    apiFallback: new Set(rows.filter((row) => row.apiFallback).map((row) => row.kind)),
    keyConcurrency: new Map(rows.filter((row) => row.keyConcurrency > 0).map((row) => [row.kind, row.keyConcurrency])),
  };
  return cached;
}

export async function accountPolicies(now = Date.now()): Promise<Map<string, AccountStrategy>> {
  return (await routingState(now)).policies;
}

export async function autoResetPolicies(now = Date.now()): Promise<AutoResetPolicies> {
  return (await routingState(now)).resets;
}

export async function apiFallbackKinds(now = Date.now()): Promise<ReadonlySet<string>> {
  return (await routingState(now)).apiFallback;
}

export async function keyConcurrencyLimits(now = Date.now()): Promise<ReadonlyMap<string, number>> {
  return (await routingState(now)).keyConcurrency;
}

export function forgetAccountPolicies(): void {
  cached = null;
}
