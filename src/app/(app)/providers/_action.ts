"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { actionFail, runAction } from "@/lib/http/action-result";
import { writeAudit } from "@/lib/gateway/audit";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import { seal } from "@/lib/crypto";
import { KNOWN_KINDS } from "@/lib/gateway/core";
import { addRoute, catalogTargets, markRouted } from "@/lib/gateway/catalog-sync";
import { loginData } from "@/lib/gateway/credentials";
import { baseName, vendorOf } from "@/lib/gateway/model-catalog";
import { refreshProviderModels } from "@/lib/gateway/discovery";
import { discoveredOf } from "@/lib/gateway/provider-prices";
import { subscriptionLimits } from "@/lib/gateway/subscription-limits";
import {
  openCredential,
  openTicket,
  pollDeviceCode,
  requestDeviceCode,
  sealCredential,
  sealTicket,
} from "@/lib/gateway/sign-in";
import { providerPolicySchema } from "@/schemas/providers";
import type {
  ImportCandidate,
  ProviderPolicyInput,
  ProviderRecord,
  ProviderSignIn,
  ProviderSyncRecord,
  SignInCredential,
  SignInPollResult,
  SignInStart,
  SubscriptionLimits,
} from "@/types/providers";

const SLOW_DOWN_STEP_S = 5;

function specFor(kind: string) {
  return PROVIDER_CATALOG.find((k) => k.kind === kind);
}

function signInOf(row: ProviderRecord): ProviderSignIn | null {
  if (!row.login) return null;
  return {
    account: row.login.account,
    plan: row.login.plan,
    status: row.login.status === "active" ? "active" : "expired",
  };
}

function publicProvider(row: ProviderRecord) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    hasApiKey: Boolean(row.apiKey),
    signIn: signInOf(row),
    discovered: discoveredOf(row.discovered),
    policy: policyOf(row),
  };
}

const loginSelect = { select: { account: true, plan: true, status: true } } as const;

function signInCredential(raw: string | undefined, uid: string, kind: string): SignInCredential | null {
  if (!raw) return null;
  const credential = openCredential(raw, uid, kind);
  if (!credential) throw new Error("SIGN_IN_EXPIRED");
  return credential;
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
  const rows = await prisma.providerConnection.findMany({
    orderBy: { createdAt: "desc" },
    include: { login: loginSelect },
  });
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
  signIn?: string;
  policy?: ProviderPolicyInput;
}) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    const kind = input.kind.trim();
    if (!KNOWN_KINDS.has(kind)) return actionFail("UNKNOWN_PROVIDER_KIND");
    const spec = specFor(kind);
    const signedIn = isSignInKind(kind);
    const credential = signedIn ? signInCredential(input.signIn, session.user.id, kind) : null;
    if (signedIn && !credential) return actionFail("SIGN_IN_REQUIRED");
    const apiKey = signedIn ? "" : input.apiKey.trim();
    const baseUrl = signedIn ? "" : input.baseUrl.trim();
    const row = await prisma.providerConnection.create({
      data: {
        name: input.name.trim() || spec?.name || kind,
        kind,
        baseUrl: validBaseUrl(baseUrl || spec?.default_base_url || ""),
        apiKey: apiKey ? seal(apiKey) : "",
        ...parsePolicy(input.policy),
        ...(credential ? { login: { create: loginData(credential.session) } } : {}),
      },
      include: { login: loginSelect },
    });
    await writeAudit({
      actor: session.user.id,
      action: "provider.connect",
      objectType: "provider",
      objectId: row.id,
      after: providerAuditAfter(row, credential ? { signInAccount: credential.session.account } : undefined),
    });
    return { provider: publicProvider(row) };
  });
}

export async function updateProviderAction(input: {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  signIn?: string;
  policy?: ProviderPolicyInput;
}) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    const existing = await prisma.providerConnection.findUnique({ where: { id: input.id } });
    if (!existing) return actionFail("NOT_FOUND");
    const signedIn = isSignInKind(existing.kind);
    const credential = signedIn ? signInCredential(input.signIn, session.user.id, existing.kind) : null;
    const apiKey = signedIn ? "" : input.apiKey.trim();
    const baseUrl = signedIn ? specFor(existing.kind)?.default_base_url ?? existing.baseUrl : input.baseUrl.trim();
    const login = credential ? loginData(credential.session) : null;
    const row = await prisma.providerConnection.update({
      where: { id: input.id },
      data: {
        name: input.name.trim() || existing.name,
        baseUrl: validBaseUrl(baseUrl || existing.baseUrl),
        ...(apiKey ? { apiKey: seal(apiKey) } : {}),
        ...(input.policy ? parsePolicy(input.policy) : {}),
        ...(login ? { login: { upsert: { create: login, update: { ...login, version: { increment: 1 } } } } } : {}),
      },
      include: { login: loginSelect },
    });
    await writeAudit({
      actor: session.user.id,
      action: "provider.update",
      objectType: "provider",
      objectId: row.id,
      after: providerAuditAfter(row, {
        keyReplaced: Boolean(apiKey),
        ...(credential ? { signInAccount: credential.session.account } : {}),
      }),
    });
    return { provider: publicProvider(row) };
  });
}

export async function loadProviderLimitsAction(input: { id: string; refresh?: boolean }) {
  return runAction(async (): Promise<{ limits: SubscriptionLimits | null }> => {
    await requirePermission(PERMISSIONS.PROVIDERS_READ);
    const row = await prisma.providerConnection.findUnique({
      where: { id: input.id },
      select: { id: true, kind: true, apiKey: true },
    });
    if (!row) throw new Error("NOT_FOUND");
    return { limits: await subscriptionLimits(row, { force: input.refresh === true }) };
  });
}

export async function startSignInAction(kind: string) {
  return runAction(async (): Promise<SignInStart> => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    if (!isSignInKind(kind)) throw new Error("UNKNOWN_PROVIDER_KIND");
    const device = await requestDeviceCode(kind);
    return {
      ticket: sealTicket(session.user.id, device),
      verificationUrl: device.verificationUrl,
      userCode: device.userCode,
      interval: device.interval,
      expiresIn: device.expiresIn,
    };
  });
}

export async function pollSignInAction(input: { ticket: string; interval: number }) {
  return runAction(async (): Promise<SignInPollResult> => {
    const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
    const ticket = openTicket(input.ticket, session.user.id);
    if (!ticket) throw new Error("SIGN_IN_EXPIRED");
    const polled = await pollDeviceCode(ticket.grant);
    if (polled.state === "denied") throw new Error("SIGN_IN_DENIED");
    if (polled.state === "expired") throw new Error("SIGN_IN_EXPIRED");
    if (polled.state === "pending") {
      const interval = Math.max(ticket.interval, Math.round(input.interval) || ticket.interval);
      return { state: "pending", interval: polled.slowDown ? interval + SLOW_DOWN_STEP_S : interval };
    }
    return {
      state: "done",
      credential: sealCredential(session.user.id, ticket.grant.kind, polled.session),
      account: polled.session.account,
      plan: polled.session.plan,
    };
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
    const row = await prisma.providerConnection.findUnique({ where: { id }, include: { login: loginSelect } });
    if (!row) return actionFail("NOT_FOUND");
    const refreshed = await refreshProviderModels(row, session.user.id);
    const provider = publicProvider({ ...refreshed.provider, login: row.login });
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
      include: { login: loginSelect },
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
    return { provider: publicProvider({ ...current, login: row.login }), added, updated, strategy };
  });
}
