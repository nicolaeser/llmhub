import "server-only";
import prisma from "@/lib/db/prisma";
import { cacheSavingsOf, cacheTokens, costOf } from "@/lib/gateway/cost";
import { groupBilling, priceAt, priceWindowQuery, priceWindowRates } from "@/lib/gateway/price-schedule";
import { capExceeded, periodElapsed } from "@/lib/gateway/period";
import { incrementRateWindow } from "@/lib/rate-limit/shared";
import { money } from "@/lib/utils/money";
import { ownerId } from "@/lib/gateway/core";
import { writeRequestLog } from "@/lib/gateway/request-log";
import { GateError } from "@/lib/gateway/errors";
import { tighterCap } from "@/lib/gateway/cost-cap";
import type { Prisma } from "@/generated/prisma/client";
import type {
  SpendHolder,
  BillingContext,
  BillingGroup,
  CostCap,
  Usage,
  Deployment,
  Principal,
} from "@/types/gateway";
import type { BudgetKind } from "@/types/structure";
import type { ResponseCacheColumns, ResponseCacheUsage } from "@/types/cache";

const HOLDER_SELECT = {
  id: true,
  spend: true,
  maxBudget: true,
  budgetDuration: true,
  spendResetAt: true,
  createdAt: true,
} as const;

async function extraCap(type: string, id: string, now: Date): Promise<number> {
  const rows = await prisma.tempBudget.findMany({
    where: { entityType: type, entityId: id, until: { gt: now } },
    select: { amount: true },
  });
  return rows.reduce((n, row) => n + money(row.amount), 0);
}

function loadHolder(kind: BudgetKind, id: string): Promise<SpendHolder | null> {
  switch (kind) {
    case "key":
      return prisma.virtualKey.findUnique({ where: { id }, select: HOLDER_SELECT });
    case "user":
      return prisma.user.findUnique({ where: { id }, select: HOLDER_SELECT });
    case "member":
      return prisma.member.findUnique({ where: { id }, select: HOLDER_SELECT });
    case "project":
      return prisma.project.findUnique({ where: { id }, select: HOLDER_SELECT });
    case "team":
      return prisma.team.findUnique({ where: { id }, select: HOLDER_SELECT });
    case "org":
      return prisma.organization.findUnique({ where: { id }, select: HOLDER_SELECT });
  }
}

async function spendAfterReset(kind: BudgetKind, row: SpendHolder, now: Date): Promise<number> {
  if (!periodElapsed(row.budgetDuration, row.spendResetAt, now, row.createdAt)) {
    return money(row.spend);
  }
  const where = { id: row.id, spendResetAt: row.spendResetAt };
  const data = { spend: 0, spendResetAt: now };
  switch (kind) {
    case "key":
      await prisma.virtualKey.updateMany({ where, data });
      break;
    case "user":
      await prisma.user.updateMany({ where, data });
      break;
    case "member":
      await prisma.member.updateMany({ where, data });
      break;
    case "project":
      await prisma.project.updateMany({ where, data });
      break;
    case "team":
      await prisma.team.updateMany({ where, data });
      break;
    case "org":
      await prisma.organization.updateMany({ where, data });
      break;
  }
  return 0;
}

export function budgetChain(principal: Principal): { kind: BudgetKind; id: string }[] {
  const chain: { kind: BudgetKind; id: string }[] = [
    { kind: "key", id: principal.key?.token_id ?? "" },
    { kind: "user", id: principal.userId },
    { kind: "member", id: principal.memberId },
    { kind: "project", id: principal.key?.project_id ?? "" },
    { kind: "team", id: principal.teamId },
    { kind: "org", id: principal.orgId },
  ];
  return chain.filter((link) => link.id);
}

export async function assertBudget(principal: Principal): Promise<CostCap | null> {
  const now = new Date();
  const chain = budgetChain(principal);
  const rows = await Promise.all(chain.map((link) => loadHolder(link.kind, link.id)));
  let tightest: CostCap | null = null;
  for (const [index, link] of chain.entries()) {
    const row = rows[index];
    if (!row) continue;
    const spend = await spendAfterReset(link.kind, row, now);
    const maxBudget = money(row.maxBudget);
    if (!(maxBudget > 0)) continue;
    const extra = await extraCap(link.kind, row.id, now);
    if (capExceeded(spend, maxBudget, extra)) {
      throw new GateError(429, "budget_exceeded", `${link.kind} budget exceeded`);
    }
    tightest = tighterCap(tightest, { limit: maxBudget + extra - spend, budget: link.kind });
  }
  return tightest;
}

export async function assertRate(principal: Principal): Promise<void> {
  const key = principal.key;
  const id = ownerId(principal);
  if (!id) return;
  const { rpm, tpm } = await incrementRateWindow(id, 1, 0);
  if (key?.rpm_limit && rpm > key.rpm_limit) {
    throw new GateError(429, "rate_limit_exceeded", "rpm exceeded");
  }
  if (key?.tpm_limit && tpm >= key.tpm_limit) {
    throw new GateError(429, "rate_limit_exceeded", "tpm exceeded");
  }
  if (principal.teamId) {
    const team = await prisma.team.findUnique({
      where: { id: principal.teamId },
      select: { rpmLimit: true, tpmLimit: true },
    });
    if (team) {
      const teamWindow = await incrementRateWindow(`team:${principal.teamId}`, 1, 0);
      if (team.rpmLimit > 0 && teamWindow.rpm > team.rpmLimit) {
        throw new GateError(429, "rate_limit_exceeded", "team rpm exceeded");
      }
      if (team.tpmLimit > 0 && teamWindow.tpm >= team.tpmLimit) {
        throw new GateError(429, "rate_limit_exceeded", "team tpm exceeded");
      }
    }
  }
}

async function billingContext(dep: Deployment | null | undefined, at: Date): Promise<BillingContext> {
  if (!dep?.id) return { mode: "routed", peers: dep ? [dep] : [] };
  const row = await prisma.deployment.findUnique({
    where: { id: dep.id },
    select: {
      group: {
        select: {
          billingMode: true,
          priceInput: true,
          priceOutput: true,
          priceTimeZone: true,
          priceWindows: priceWindowQuery,
          deployments: { select: { costInput: true, costOutput: true } },
        },
      },
    },
  });
  const group = row?.group;
  if (!group) return { mode: "routed", peers: [dep] };
  return {
    mode: group.billingMode || "routed",
    peers: group.deployments.map((item) => ({
      cost_input_per_1k: money(item.costInput),
      cost_output_per_1k: money(item.costOutput),
    })),
    price: priceAt(
      {
        price: {
          cost_input_per_1k: money(group.priceInput),
          cost_output_per_1k: money(group.priceOutput),
        },
        time_zone: group.priceTimeZone,
        windows: group.priceWindows.map(priceWindowRates),
      },
      at,
    ),
  };
}

export function responseCacheColumns(
  responseCache: ResponseCacheUsage | undefined,
  cost: number,
): ResponseCacheColumns {
  const event = responseCache?.event;
  const hit = responseCache && (event === "hit" || event === "semantic_hit") ? responseCache : null;
  return {
    responseCacheHits: hit ? 1 : 0,
    responseCacheSemanticHits: event === "semantic_hit" ? 1 : 0,
    responseCacheMisses: event === "miss" ? 1 : 0,
    responseCacheSavedTokens: hit ? Math.max(0, Math.round(hit.savedTokens ?? 0)) : 0,
    responseCacheSavedCost: hit ? Math.max(0, hit.savedCost ?? 0) : 0,
    responseCacheLookupCost: event === "lookup" ? cost : 0,
  };
}

export async function recordUsage(input: {
  principal: Principal;
  model: string;
  deployment?: Deployment | null;
  group?: BillingGroup | null;
  usage?: Partial<Usage>;
  status: number;
  outcome: string;
  latencyMs: number;
  tag?: string;
  stream?: boolean;
  request?: unknown;
  response?: unknown;
  error?: unknown;
  responseCache?: ResponseCacheUsage;
}): Promise<number> {
  const usage = input.usage ?? {};
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const startedAt = new Date(Date.now() - Math.max(0, input.latencyMs));
  const billing =
    input.group && input.group.alias !== "auto"
      ? groupBilling(input.group, startedAt)
      : await billingContext(input.deployment, startedAt);
  const cost = costOf(input.deployment, usage, billing);
  const cache = cacheTokens(usage);
  const cacheSavings = cacheSavingsOf(input.deployment, usage, billing);
  const keyId = input.principal.key?.token_id ?? "";
  const userId = input.principal.userId;
  const teamId = input.principal.teamId;
  const orgId = input.principal.orgId;
  const projectId = input.principal.key?.project_id ?? "";
  const memberId = input.principal.memberId;

  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const slice = { day, keyId, teamId, orgId, projectId, memberId, userId, model: input.model };
  const failed = input.status >= 400 ? 1 : 0;
  const limited = input.status === 429 ? 1 : 0;
  const responseCache = responseCacheColumns(input.responseCache, cost);
  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.usageDaily.upsert({
      where: { slice },
      create: {
        ...slice,
        requests: 1,
        errors: failed,
        rateLimited: limited,
        latencyMs: input.latencyMs,
        promptTokens: prompt,
        completionTokens: completion,
        cacheReadTokens: cache.read,
        cacheWriteTokens: cache.written,
        cost,
        cacheSavings,
        ...responseCache,
      },
      update: {
        requests: { increment: 1 },
        errors: { increment: failed },
        rateLimited: { increment: limited },
        latencyMs: { increment: input.latencyMs },
        promptTokens: { increment: prompt },
        completionTokens: { increment: completion },
        cacheReadTokens: { increment: cache.read },
        cacheWriteTokens: { increment: cache.written },
        cost: { increment: cost },
        cacheSavings: { increment: cacheSavings },
        responseCacheHits: { increment: responseCache.responseCacheHits },
        responseCacheSemanticHits: { increment: responseCache.responseCacheSemanticHits },
        responseCacheMisses: { increment: responseCache.responseCacheMisses },
        responseCacheSavedTokens: { increment: responseCache.responseCacheSavedTokens },
        responseCacheSavedCost: { increment: responseCache.responseCacheSavedCost },
        responseCacheLookupCost: { increment: responseCache.responseCacheLookupCost },
      },
    }),
  ];
  if (prompt || completion || cost) {
    writes.push(
      prisma.spendEvent.create({
        data: {
          keyId,
          teamId,
          orgId,
          projectId,
          memberId,
          userId,
          model: input.model,
          deployment: input.deployment?.id ?? "",
          tag: input.tag ?? "",
          promptTokens: prompt,
          completionTokens: completion,
          cost,
        },
      }),
    );
  }
  if (cost) {
    const increment = { spend: { increment: cost } };
    if (keyId) writes.push(prisma.virtualKey.updateMany({ where: { id: keyId }, data: increment }));
    if (userId) writes.push(prisma.user.updateMany({ where: { id: userId }, data: increment }));
    if (memberId) writes.push(prisma.member.updateMany({ where: { id: memberId }, data: increment }));
    if (teamId) writes.push(prisma.team.updateMany({ where: { id: teamId }, data: increment }));
    if (orgId) writes.push(prisma.organization.updateMany({ where: { id: orgId }, data: increment }));
    if (projectId) writes.push(prisma.project.updateMany({ where: { id: projectId }, data: increment }));
  }
  await prisma.$transaction(writes);
  const tokens = prompt + completion;
  const owner = ownerId(input.principal);
  if (tokens && owner) {
    await incrementRateWindow(owner, 0, tokens);
    if (teamId) await incrementRateWindow(`team:${teamId}`, 0, tokens);
  }

  await writeRequestLog({
    principal: input.principal,
    model: input.model,
    deployment: input.deployment,
    status: input.status,
    outcome: input.outcome,
    latencyMs: input.latencyMs,
    tag: input.tag ?? "",
    promptTokens: prompt,
    completionTokens: completion,
    cacheReadTokens: cache.read,
    cacheWriteTokens: cache.written,
    cost,
    stream: input.stream,
    request: input.request,
    response: input.response,
    error: input.error,
  });
  return cost;
}

function tokenCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function detail(rec: Record<string, unknown>, key: string, field: string): number {
  const value = rec[key];
  return value && typeof value === "object" ? tokenCount((value as Record<string, unknown>)[field]) : 0;
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function reportedCost(rec: Record<string, unknown>): number | undefined {
  if (typeof rec.cost !== "number" || !Number.isFinite(rec.cost) || rec.cost < 0) return undefined;
  return rec.cost + detail(rec, "cost_details", "upstream_inference_cost");
}

export function usageFromUnknown(value: unknown, envelope?: unknown): Partial<Usage> {
  if (!value || typeof value !== "object") return {};
  const rec = value as Record<string, unknown>;
  const top = envelope && typeof envelope === "object" ? (envelope as Record<string, unknown>) : {};
  const prompt = tokenCount(rec.prompt_tokens ?? rec.input_tokens);
  const completion = tokenCount(rec.completion_tokens ?? rec.output_tokens);
  const cached =
    tokenCount(rec.cache_read_input_tokens) ||
    detail(rec, "prompt_tokens_details", "cached_tokens") ||
    detail(rec, "input_tokens_details", "cached_tokens");
  const created = tokenCount(rec.cache_creation_input_tokens);
  const createdLong = Math.min(created, detail(rec, "cache_creation", "ephemeral_1h_input_tokens"));
  const reasoning =
    detail(rec, "completion_tokens_details", "reasoning_tokens") ||
    detail(rec, "output_tokens_details", "reasoning_tokens");
  const hidden = tokenCount(rec.total_tokens) - prompt - completion;
  const unbilledReasoning = hidden > 0 && hidden !== cached && (!reasoning || hidden === reasoning) ? hidden : 0;
  const output = completion + unbilledReasoning;
  const tier = label(rec.service_tier) ?? label(top.service_tier);
  const speed = label(rec.speed);
  const geo = label(rec.inference_geo);
  const cost = reportedCost(rec);
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    cache_read_input_tokens: cached || undefined,
    cache_creation_input_tokens: created || undefined,
    cache_creation_1h_input_tokens: createdLong || undefined,
    ...(tier ? { service_tier: tier } : {}),
    ...(speed ? { speed } : {}),
    ...(geo ? { inference_geo: geo } : {}),
    ...(cost === undefined ? {} : { cost }),
  };
}
