import "server-only";

import prisma from "@/lib/db/prisma";
import { systemPrincipal } from "@/lib/gateway/access/system-principal";
import { usageFromUnknown } from "@/lib/gateway/billing/billing";
import { meter } from "@/lib/gateway/billing/meter";
import { asRecord } from "@/lib/gateway/core";
import { chatOnce } from "@/lib/gateway/dispatch/chat";
import { GateError } from "@/lib/gateway/errors";
import { windowKickoffDue } from "@/lib/gateway/routing/quota";
import { loadGroup } from "@/lib/gateway/routing/runtime";
import { limitsOf, nudgeLimits } from "@/lib/gateway/upstreams/limit-store";
import { startsWindows } from "@/lib/gateway/upstreams/provider-kinds";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type { ResolvedDeployment, ResolvedModelGroup } from "@/types/routing";

const KICKOFF_PROMPT = "Only reply with ok.";
const KICKOFF_SWEEP_LIMIT = 8;

type KickoffTarget = {
  providerId: string;
  kind: string;
  model: string;
  dep: ResolvedDeployment;
  group: ResolvedModelGroup;
  lastKickoff: Date | null;
};

async function kickoffGroups(models: string[]): Promise<Map<string, ResolvedModelGroup>> {
  const groups = new Map<string, ResolvedModelGroup>();
  for (const model of new Set(models)) {
    try {
      groups.set(model, await loadGroup(model));
    } catch (err) {
      logger.warn("provider.window_kickoff_model_missing", { model, ...errorFields(err) });
    }
  }
  return groups;
}

async function dueKickoffs(now = Date.now()): Promise<KickoffTarget[]> {
  const policies = await prisma.accountRouting.findMany({
    where: { kickoffModel: { not: "" } },
    select: { kind: true, kickoffModel: true },
  });
  const models = new Map(policies.filter((row) => startsWindows(row.kind)).map((row) => [row.kind, row.kickoffModel]));
  if (!models.size) return [];
  const accounts = await prisma.providerConnection.findMany({
    where: { kind: { in: [...models.keys()] }, enabled: true, login: { is: { status: "active" } } },
    select: { id: true, kind: true, limitSnapshot: { select: { limits: true, fetchedAt: true, kickoffAt: true } } },
  });
  const groups = await kickoffGroups([...models.values()]);
  const due: KickoffTarget[] = [];
  for (const account of accounts) {
    const model = models.get(account.kind)!;
    const group = groups.get(model);
    const dep = group?.mapped.find((item) => item.provider?.id === account.id);
    const snapshot = account.limitSnapshot;
    if (!group || !dep || !snapshot?.fetchedAt) continue;
    const lastKickoff = snapshot.kickoffAt;
    if (!windowKickoffDue(limitsOf(snapshot.limits), dep.model, lastKickoff?.getTime() ?? null, now)) continue;
    due.push({ providerId: account.id, kind: account.kind, model, dep, group, lastKickoff });
    if (due.length >= KICKOFF_SWEEP_LIMIT) break;
  }
  return due;
}

async function claimKickoff(target: KickoffTarget, now: number): Promise<boolean> {
  const claimed = await prisma.providerLimitSnapshot.updateMany({
    where: { providerId: target.providerId, kickoffAt: target.lastKickoff },
    data: { kickoffAt: new Date(now) },
  });
  return claimed.count > 0;
}

async function sendKickoff(target: KickoffTarget): Promise<boolean> {
  const body = { model: target.model, messages: [{ role: "user", content: KICKOFF_PROMPT }] };
  const usage = meter(systemPrincipal("kickoff"), target.model, body);
  try {
    const json = await chatOnce(target.dep, target.group, body, target.model);
    await usage.ok({ dep: target.dep, group: target.group, json, status: 200 }, usageFromUnknown(asRecord(json)?.usage, json));
    logger.info("provider.window_kickoff", { providerId: target.providerId, kind: target.kind, model: target.model });
    return true;
  } catch (err) {
    await usage.fail(err);
    logger.warn("provider.window_kickoff_failed", {
      providerId: target.providerId,
      kind: target.kind,
      model: target.model,
      status: err instanceof GateError ? err.status : null,
      ...errorFields(err),
    });
    return false;
  } finally {
    nudgeLimits(target.providerId, target.kind);
  }
}

export async function runWindowKickoffs(now = Date.now()): Promise<number> {
  const due = await dueKickoffs(now);
  const sent = await Promise.all(
    due.map(async (target) => ((await claimKickoff(target, now)) ? sendKickoff(target) : false)),
  );
  return sent.filter(Boolean).length;
}
