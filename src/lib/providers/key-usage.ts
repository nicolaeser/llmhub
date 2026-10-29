import "server-only";
import prisma from "@/lib/db/prisma";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { readLimitSnapshots } from "@/lib/gateway/upstreams/limit-store";
import { usageWindows, windowUsage } from "@/lib/providers/key-usage-shares";
import { money } from "@/lib/utils/money";
import type { KeyUsageRow, SubscriptionKeyUsage, UsageKeyLabel } from "@/types/providers";

const QUERY_CONCURRENCY = 4;

type UsageQuery = { providerId: string; since: number };

function queryKey(providerId: string, since: number): string {
  return `${providerId}|${since}`;
}

async function usageRows(query: UsageQuery): Promise<KeyUsageRow[]> {
  const groups = await prisma.requestLog.groupBy({
    by: ["keyId", "upstreamModel"],
    where: { providerId: query.providerId, createdAt: { gte: new Date(query.since) } },
    _count: { _all: true },
    _sum: { cost: true, promptTokens: true, completionTokens: true },
  });
  return groups.map((group) => ({
    keyId: group.keyId,
    upstreamModel: group.upstreamModel,
    requests: group._count._all,
    tokens: (group._sum.promptTokens ?? 0) + (group._sum.completionTokens ?? 0),
    cost: money(group._sum.cost),
  }));
}

async function rowsByQuery(queries: UsageQuery[]): Promise<Map<string, KeyUsageRow[]>> {
  const rows = new Map<string, KeyUsageRow[]>();
  for (let i = 0; i < queries.length; i += QUERY_CONCURRENCY) {
    const batch = queries.slice(i, i + QUERY_CONCURRENCY);
    const results = await Promise.all(batch.map(usageRows));
    batch.forEach((query, index) => rows.set(queryKey(query.providerId, query.since), results[index] ?? []));
  }
  return rows;
}

async function keyLabels(ids: string[]): Promise<Record<string, UsageKeyLabel>> {
  if (!ids.length) return {};
  const keys = await prisma.virtualKey.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      keyAlias: true,
      prefix: true,
      org: { select: { alias: true } },
      project: { select: { alias: true } },
      member: { select: { name: true } },
      user: { select: { email: true } },
    },
  });
  return Object.fromEntries(
    keys.map((key) => [
      key.id,
      {
        label: key.keyAlias || key.prefix,
        company: key.org?.alias ?? "",
        owner: key.project?.alias ?? key.member?.name ?? key.user?.email ?? "",
      },
    ]),
  );
}

export async function loadSubscriptionKeyUsage(): Promise<SubscriptionKeyUsage> {
  const session = await requirePlatformPermission(PERMISSIONS.PROVIDERS_READ);
  if (!hasPerm(session.permissions, PERMISSIONS.SPEND_READ_ALL)) throw new Error("FORBIDDEN");
  const at = Date.now();
  const snapshots = (await readLimitSnapshots(undefined, at)).filter((snapshot) => snapshot.limits);
  const connections = await prisma.providerConnection.findMany({
    where: { id: { in: snapshots.map((snapshot) => snapshot.id) } },
    select: { id: true, kind: true },
  });
  const kinds = new Map(connections.map((connection) => [connection.id, connection.kind]));
  const plans = snapshots.flatMap((snapshot) => {
    const kind = kinds.get(snapshot.id);
    return kind ? [{ id: snapshot.id, windows: usageWindows(kind, snapshot.limits, at) }] : [];
  });
  const queries = new Map<string, UsageQuery>();
  for (const plan of plans) {
    for (const window of plan.windows) {
      queries.set(queryKey(plan.id, window.since), { providerId: plan.id, since: window.since });
    }
  }
  const rows = await rowsByQuery([...queries.values()]);
  const accounts = plans.map((plan) => ({
    id: plan.id,
    windows: plan.windows.map((window) => windowUsage(window, rows.get(queryKey(plan.id, window.since)) ?? [])),
  }));
  const keyIds = new Set(accounts.flatMap((account) => account.windows.flatMap((window) => window.keys)).map((key) => key.keyId));
  keyIds.delete("");
  return { at, accounts, keys: await keyLabels([...keyIds]) };
}
