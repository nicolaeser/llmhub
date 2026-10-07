"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { actionFail, runAction } from "@/lib/http/action-result";
import { writeAudit } from "@/lib/gateway/audit";
import { PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import { seal } from "@/lib/crypto";
import { KNOWN_KINDS } from "@/lib/gateway/core";
import { addRoute, catalogTargets, markRouted } from "@/lib/gateway/catalog-sync";
import { baseName, vendorOf } from "@/lib/gateway/model-catalog";
import { refreshProviderModels } from "@/lib/gateway/discovery";
import { discoveredOf } from "@/lib/gateway/provider-prices";
import { providerPolicySchema } from "@/schemas/providers";
import type { ImportCandidate, ProviderPolicyInput, ProviderRecord, ProviderSyncRecord } from "@/types/providers";

function specFor(kind: string) {
  return PROVIDER_CATALOG.find((k) => k.kind === kind);
}

function publicProvider(row: ProviderRecord) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    hasApiKey: Boolean(row.apiKey),
    discovered: discoveredOf(row.discovered),
    policy: policyOf(row),
  };
}

function policyOf(row: ProviderRecord): ProviderPolicyInput {
  return {
    zdr: row.zdr,
    retentionDays: row.zdr ? 0 : row.retentionDays,
    region: row.region,
    noTraining: row.zdr || row.noTraining,
  };
}

function parsePolicy(raw: unknown): ProviderPolicyInput {
  const parsed = providerPolicySchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error("VALIDATION");
  const policy = parsed.data;
  return policy.zdr ? { ...policy, retentionDays: 0, noTraining: true } : policy;
}

function providerAuditAfter(row: ProviderRecord, extra?: Record<string, unknown>) {
  return { name: row.name, kind: row.kind, baseUrl: row.baseUrl, policy: policyOf(row), ...extra };
}

function validBaseUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString().replace(/\/$/, "");
  } catch {}
  throw new Error("INVALID_URL");
}

async function listConnected() {
  const rows = await prisma.providerConnection.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(publicProvider);
}

export async function loadProvidersAction() {
  return runAction(async () => {
    await requirePermission(PERMISSIONS.PROVIDERS_READ);
    return { connected: await listConnected() };
  });
}

export async function createProviderAction(input: {
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  policy?: ProviderPolicyInput;
}) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    const kind = input.kind.trim();
    if (!KNOWN_KINDS.has(kind)) return actionFail("UNKNOWN_PROVIDER_KIND");
    const spec = specFor(kind);
    const apiKey = input.apiKey.trim();
    const row = await prisma.providerConnection.create({
      data: {
        name: input.name.trim() || spec?.name || kind,
        kind,
        baseUrl: validBaseUrl(input.baseUrl.trim() || spec?.default_base_url || ""),
        apiKey: apiKey ? seal(apiKey) : "",
        ...parsePolicy(input.policy),
      },
    });
    await writeAudit({
      actor: session.user.id,
      action: "provider.connect",
      objectType: "provider",
      objectId: row.id,
      after: providerAuditAfter(row),
    });
    return { provider: publicProvider(row) };
  });
}

export async function updateProviderAction(input: {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  policy?: ProviderPolicyInput;
}) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    const existing = await prisma.providerConnection.findUnique({ where: { id: input.id } });
    if (!existing) return actionFail("NOT_FOUND");
    const apiKey = input.apiKey.trim();
    const row = await prisma.providerConnection.update({
      where: { id: input.id },
      data: {
        name: input.name.trim() || existing.name,
        baseUrl: validBaseUrl(input.baseUrl.trim() || existing.baseUrl),
        ...(apiKey ? { apiKey: seal(apiKey) } : {}),
        ...(input.policy ? parsePolicy(input.policy) : {}),
      },
    });
    await writeAudit({
      actor: session.user.id,
      action: "provider.update",
      objectType: "provider",
      objectId: row.id,
      after: providerAuditAfter(row, { keyReplaced: Boolean(apiKey) }),
    });
    return { provider: publicProvider(row) };
  });
}

export async function deleteProviderAction(id: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    if (!id) return actionFail("MISSING_ID");
    const n = await prisma.deployment.count({ where: { providerId: id } });
    if (n > 0) {
      return actionFail("PROVIDER_IN_USE");
    }
    if (!(await prisma.providerConnection.findUnique({ where: { id }, select: { id: true } }))) {
      return actionFail("NOT_FOUND");
    }
    const row = await prisma.providerConnection.delete({ where: { id } });
    await writeAudit({
      actor: session.user.id,
      action: "provider.delete",
      objectType: "provider",
      objectId: row.id,
      after: providerAuditAfter(row),
    });
    return { id: row.id };
  });
}

export async function discoverProviderAction(id: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    const row = await prisma.providerConnection.findUnique({ where: { id } });
    if (!row) return actionFail("NOT_FOUND");
    const refreshed = await refreshProviderModels(row, session.user.id);
    const provider = publicProvider(refreshed.provider);
    const [targets, groups] = await Promise.all([
      catalogTargets(row.id),
      prisma.modelGroup.findMany({ select: { alias: true } }),
    ]);
    const known = new Set(groups.map((group) => group.alias));
    const models: ImportCandidate[] = provider.discovered.map((model) => {
      const alias = targets.get(model.id)?.alias ?? "";
      return { id: model.id, name: model.name, alias, exists: known.has(alias) };
    });
    return { provider, models };
  });
}

export async function importProviderModelsAction(input: {
  id: string;
  models: string[];
  strategy?: string;
}) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    const row = await prisma.providerConnection.findUnique({
      where: { id: input.id },
    });
    if (!row) return actionFail("NOT_FOUND");
    let current: ProviderSyncRecord = row;
    let discovered = discoveredOf(row.discovered);
    if (discovered.length === 0) {
      current = (await refreshProviderModels(row, session.user.id)).provider;
      discovered = discoveredOf(current.discovered);
    }
    const byId = new Map(discovered.map((m) => [m.id, m]));
    let ids = input.models.filter(Boolean);
    if (ids.length === 0) ids = discovered.map((m) => m.id);
    if (ids.length > 200) ids = ids.slice(0, 200);
    const strategy = input.strategy?.trim() || "cost_lowest";
    const targets = await catalogTargets(row.id);
    let added = 0;
    let updated = 0;
    for (const modelId of ids) {
      const target = targets.get(modelId) ?? {
        providerId: row.id,
        upstreamId: modelId,
        alias: baseName(modelId),
        vendor: vendorOf(row.kind, modelId),
        name: "",
      };
      if (!target.alias) continue;
      const info = byId.get(modelId) ?? {
        id: modelId,
        name: modelId,
        ownedBy: row.kind,
        contextLength: 0,
        costInputPer1k: 0,
        costOutputPer1k: 0,
        priceSource: "none",
      };
      const outcome = await addRoute({
        provider: row,
        model: info,
        alias: target.alias,
        vendor: target.vendor,
        displayName: target.name,
        strategy,
      });
      await markRouted(target);
      if (outcome === "updated") updated += 1;
      else added += 1;
    }
    await writeAudit({
      actor: session.user.id,
      action: "provider.import",
      objectType: "provider",
      objectId: row.id,
      after: providerAuditAfter(row, { added, updated, strategy }),
    });
    return { provider: publicProvider(current), added, updated, strategy };
  });
}
