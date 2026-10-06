"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { actionFail, runAction } from "@/lib/http/action-result";
import { writeAudit } from "@/lib/gateway/audit";
import {
  asStringArray,
  KNOWN_BILLING_MODES,
  KNOWN_KINDS,
  KNOWN_STRATEGIES,
} from "@/lib/gateway/core";
import {
  catalogPricesOf,
  priceForUpstream,
} from "@/lib/gateway/provider-prices";
import type { DeploymentInput } from "@/types/models";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";

function strategyOf(v: string | undefined, fallback = "least_inflight"): string {
  const s = (v ?? "").trim();
  return KNOWN_STRATEGIES.has(s) ? s : fallback;
}

function kindOf(v: string | undefined): string {
  const s = (v ?? "").trim();
  return KNOWN_KINDS.has(s) ? s : "openai_compat";
}

function billingModeOf(v: string | undefined, fallback = "routed"): string {
  const s = (v ?? "").trim();
  return KNOWN_BILLING_MODES.has(s) ? s : fallback;
}

function fallbacksOf(v: unknown): string[] {
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return asStringArray(v);
}

function mapDeployment(d: {
  id: string;
  groupAlias: string;
  kind: string;
  baseUrl: string;
  model: string;
  weight: number;
  costInput: Prisma.Decimal;
  costOutput: Prisma.Decimal;
  providerId: string | null;
}) {
  return {
    id: d.id,
    groupAlias: d.groupAlias,
    kind: d.kind,
    baseUrl: d.baseUrl,
    model: d.model,
    weight: d.weight,
    costInput: money(d.costInput),
    costOutput: money(d.costOutput),
    providerId: d.providerId,
  };
}

function groupAudit(g: {
  alias: string;
  strategy: string;
  billingMode: string;
  overflowGroup: string;
  numRetries: number;
  fallbackGroups: unknown;
  deployments?: Parameters<typeof mapDeployment>[0][];
}) {
  return {
    alias: g.alias,
    strategy: g.strategy,
    billingMode: g.billingMode,
    overflowGroup: g.overflowGroup,
    numRetries: g.numRetries,
    fallbackGroups: asStringArray(g.fallbackGroups),
    deployments: (g.deployments ?? []).map(mapDeployment),
  };
}

function mapGroup(g: {
  alias: string;
  strategy: string;
  billingMode: string;
  overflowGroup: string;
  numRetries: number;
  fallbackGroups: unknown;
  deployments: Parameters<typeof mapDeployment>[0][];
}) {
  return {
    alias: g.alias,
    strategy: g.strategy,
    billingMode: g.billingMode,
    overflowGroup: g.overflowGroup,
    numRetries: g.numRetries,
    fallbackGroups: asStringArray(g.fallbackGroups),
    endpoints: g.deployments.length,
    deployments: g.deployments.map(mapDeployment),
  };
}

async function listGroups() {
  const groups = await prisma.modelGroup.findMany({
    include: { deployments: true },
    orderBy: { alias: "asc" },
  });
  return groups.map(mapGroup);
}

async function listProviders() {
  const rows = await prisma.providerConnection.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      kind: true,
      baseUrl: true,
      apiKey: true,
      discovered: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    hasApiKey: Boolean(row.apiKey),
    discovered: catalogPricesOf(row.discovered).map((item) => ({
      id: item.id,
      costInputPer1k: item.costInput,
      costOutputPer1k: item.costOutput,
      priceSource: item.priceSource,
    })),
  }));
}

async function payload() {
  return { groups: await listGroups(), providers: await listProviders() };
}

async function withCatalogPrices(deps: DeploymentInput[]): Promise<DeploymentInput[]> {
  const ids = [
    ...new Set(deps.map((d) => d.providerId).filter((id): id is string => Boolean(id))),
  ];
  if (!ids.length) return deps;
  const rows = await prisma.providerConnection.findMany({
    where: { id: { in: ids } },
    select: { id: true, discovered: true },
  });
  const byId = new Map(rows.map((row) => [row.id, catalogPricesOf(row.discovered)]));
  return deps.map((d) => {
    if (!d.providerId) return d;
    if (d.costInput > 0 || d.costOutput > 0) return d;
    if (d.id) return d;
    const hit = priceForUpstream(byId.get(d.providerId) ?? [], d.model);
    if (!hit) return d;
    return { ...d, costInput: hit.costInput, costOutput: hit.costOutput };
  });
}

function depFields(d: DeploymentInput) {
  return {
    kind: kindOf(d.kind),
    baseUrl: d.baseUrl.trim(),
    model: d.model.trim(),
    weight: Math.max(1, Math.trunc(d.weight) || 1),
    costInput: Number(d.costInput) || 0,
    costOutput: Number(d.costOutput) || 0,
    providerId: d.providerId || null,
  };
}

function depCreateData(groupAlias: string, d: DeploymentInput) {
  return { groupAlias, ...depFields(d) };
}

export async function loadModelsAction() {
  return runAction(async () => {
    await requirePermission(PERMISSIONS.MODELS_READ);
    return payload();
  });
}

export async function createModelGroupAction(input: {
  alias: string;
  strategy: string;
  billingMode?: string;
  numRetries: number;
  overflowGroup: string;
  fallbackGroups: string[] | string;
  deployments?: DeploymentInput[];
}) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.MODELS_MANAGE);
    const alias = input.alias.trim();
    if (!alias) return actionFail("ALIAS_REQUIRED");
    const existing = await prisma.modelGroup.findUnique({ where: { alias } });
    if (existing) return actionFail("ALIAS_EXISTS");
    const deployments = await withCatalogPrices(
      (input.deployments ?? []).filter((d) => d.model.trim()),
    );
    const row = await prisma.modelGroup.create({
      data: {
        alias,
        strategy: strategyOf(input.strategy),
        billingMode: billingModeOf(input.billingMode),
        numRetries: Math.max(0, Math.trunc(input.numRetries) || 0),
        overflowGroup: input.overflowGroup.trim(),
        fallbackGroups: fallbacksOf(input.fallbackGroups),
        deployments: deployments.length
          ? { create: deployments.map((d) => depFields(d)) }
          : undefined,
      },
      include: { deployments: true },
    });
    await writeAudit({
      actor: session.user.id,
      action: "model.create",
      objectType: "model",
      objectId: row.alias,
      after: groupAudit(row),
    });
    return mapGroup(row);
  });
}

export async function updateModelGroupAction(input: {
  alias: string;
  strategy: string;
  billingMode?: string;
  numRetries: number;
  overflowGroup: string;
  fallbackGroups: string[] | string;
  deployments?: DeploymentInput[];
}) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.MODELS_MANAGE);
    const alias = input.alias.trim();
    const existing = await prisma.modelGroup.findUnique({
      where: { alias },
      include: { deployments: true },
    });
    if (!existing) return actionFail("NOT_FOUND");
    await prisma.modelGroup.update({
      where: { alias },
      data: {
        strategy: strategyOf(input.strategy, existing.strategy),
        billingMode: billingModeOf(input.billingMode, existing.billingMode),
        numRetries: Math.max(0, Math.trunc(input.numRetries) || 0),
        overflowGroup: input.overflowGroup.trim(),
        fallbackGroups: fallbacksOf(input.fallbackGroups),
      },
    });
    if (input.deployments) {
      const priced = await withCatalogPrices(input.deployments);
      const keep = new Set(
        priced.map((d) => d.id).filter((id): id is string => Boolean(id)),
      );
      await prisma.deployment.deleteMany({
        where: { groupAlias: alias, id: { notIn: [...keep] } },
      });
      for (const d of priced) {
        const data = depCreateData(alias, d);
        if (d.id && existing.deployments.some((x) => x.id === d.id)) {
          await prisma.deployment.update({
            where: { id: d.id },
            data: {
              kind: data.kind,
              baseUrl: data.baseUrl,
              model: data.model,
              weight: data.weight,
              costInput: data.costInput,
              costOutput: data.costOutput,
              providerId: data.providerId,
            },
          });
        } else {
          await prisma.deployment.create({ data });
        }
      }
    }
    const after = await prisma.modelGroup.findUnique({
      where: { alias },
      include: { deployments: true },
    });
    await writeAudit({
      actor: session.user.id,
      action: "model.update",
      objectType: "model",
      objectId: alias,
      before: groupAudit(existing),
      after: after ? groupAudit(after) : undefined,
    });
    if (!after) return actionFail("NOT_FOUND");
    return mapGroup(after);
  });
}

export async function deleteModelGroupAction(alias: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.MODELS_MANAGE);
    const id = alias.trim();
    if (!id) return actionFail("MISSING_ID");
    if (!(await prisma.modelGroup.findUnique({ where: { alias: id }, select: { alias: true } }))) {
      return actionFail("NOT_FOUND");
    }
    const row = await prisma.modelGroup.delete({
      where: { alias: id },
      include: { deployments: true },
    });
    await writeAudit({
      actor: session.user.id,
      action: "model.delete",
      objectType: "model",
      objectId: row.alias,
      before: groupAudit(row),
    });
    return { alias: row.alias };
  });
}
