import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import {
  isSignInKind,
  PROVIDER_CATALOG,
  reportsLimits,
  signInMethod,
} from "@/lib/gateway/upstreams/provider-kinds";
import { seal } from "@/lib/crypto";
import { asStringArray, KNOWN_KINDS } from "@/lib/gateway/core";
import { addRoute, catalogTargets, markRouted } from "@/lib/gateway/catalog/catalog-sync";
import { scheduleCatalogTask } from "@/lib/gateway/catalog/catalog-tasks";
import { assignmentSelect, assignmentTargets } from "@/lib/gateway/routing/account-assignments";
import { loginData } from "@/lib/gateway/upstreams/credentials";
import { baseName, vendorOf } from "@/lib/gateway/catalog/model-catalog";
import { refreshProviderModels } from "@/lib/gateway/upstreams/discovery";
import { discoveredOf } from "@/lib/gateway/upstreams/provider-prices";
import { subscriptionLimits } from "@/lib/gateway/upstreams/subscription-limits";
import {
  completeAuthorization,
  openCredential,
  openTicket,
  pollDeviceCode,
  sealCredential,
  sealTicket,
  startAuthorization,
} from "@/lib/gateway/upstreams/subscription-sign-in";
import { providerPolicySchema } from "@/schemas/providers";
import type {
  AccountLimits,
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
    enabled: row.enabled,
    restricted: row.restricted,
    assignments: assignmentTargets(row.assignments ?? []),
    signIn: signInOf(row),
    discovered: discoveredOf(row.discovered),
    policy: policyOf(row),
  };
}

const loginSelect = { select: { account: true, plan: true, status: true } } as const;
const providerInclude = { login: loginSelect, assignments: assignmentSelect } as const;

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
  const url = URL.canParse(value) ? new URL(value) : null;
  if (url && (url.protocol === "https:" || url.protocol === "http:")) return url.toString().replace(/\/$/, "");
  throw new Error("INVALID_URL");
}

async function listConnected() {
  const rows = await prisma.providerConnection.findMany({
    orderBy: { createdAt: "desc" },
    include: providerInclude,
  });
  return rows.map(publicProvider);
}

export async function loadProviders() {
  await requirePermission(PERMISSIONS.PROVIDERS_READ);
  return { connected: await listConnected() };
}

export async function createProvider(input: {
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  signIn?: string;
  policy?: ProviderPolicyInput;
}) {
  const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
  const kind = input.kind.trim();
  if (!KNOWN_KINDS.has(kind)) throw new Error("UNKNOWN_PROVIDER_KIND");
  const spec = specFor(kind);
  const signedIn = isSignInKind(kind);
  const credential = signedIn ? signInCredential(input.signIn, session.user.id, kind) : null;
  if (signedIn && !credential) throw new Error("SIGN_IN_REQUIRED");
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
    include: providerInclude,
  });
  await writeAudit({
    actor: session.user.id,
    action: "provider.connect",
    objectType: "provider",
    objectId: row.id,
    after: providerAuditAfter(row, credential ? { signInAccount: credential.session.account } : undefined),
  });
  await scheduleCatalogTask({ task: "provider", providerId: row.id });
  return { provider: publicProvider(row) };
}

export async function updateProvider(input: {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  signIn?: string;
  policy?: ProviderPolicyInput;
}) {
  const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
  const existing = await prisma.providerConnection.findUnique({ where: { id: input.id } });
  if (!existing) throw new Error("NOT_FOUND");
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
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.policy ? parsePolicy(input.policy) : {}),
      ...(login ? { login: { upsert: { create: login, update: { ...login, version: { increment: 1 } } } } } : {}),
    },
    include: providerInclude,
  });
  await writeAudit({
    actor: session.user.id,
    action: "provider.update",
    objectType: "provider",
    objectId: row.id,
    after: providerAuditAfter(row, {
      enabled: row.enabled,
      keyReplaced: Boolean(apiKey),
      ...(credential ? { signInAccount: credential.session.account } : {}),
    }),
  });
  if (apiKey || credential || row.baseUrl !== existing.baseUrl) {
    await scheduleCatalogTask({ task: "provider", providerId: row.id });
  }
  return { provider: publicProvider(row) };
}

export async function loadProviderLimits(input: { id: string; refresh?: boolean }): Promise<{ limits: SubscriptionLimits | null }> {
  await requirePermission(PERMISSIONS.PROVIDERS_READ);
  const row = await prisma.providerConnection.findUnique({
    where: { id: input.id },
    select: { id: true, kind: true, apiKey: true },
  });
  if (!row) throw new Error("NOT_FOUND");
  return { limits: await subscriptionLimits(row, { force: input.refresh === true }) };
}

const LIMIT_ERRORS = new Set(["SIGN_IN_EXPIRED", "UPSTREAM_AUTH", "UPSTREAM_FAILED"]);

export async function loadSubscriptionLimits(input: { refresh?: boolean } = {}): Promise<{ items: AccountLimits[] }> {
  await requirePermission(PERMISSIONS.PROVIDERS_READ);
  const rows = await prisma.providerConnection.findMany({
    where: {
      kind: { in: PROVIDER_CATALOG.filter((spec) => reportsLimits(spec.kind)).map((spec) => spec.kind) },
      login: { is: { status: "active" } },
    },
    select: { id: true, kind: true, apiKey: true },
  });
  const items = await Promise.all(
    rows.map(async (row): Promise<AccountLimits> => {
      try {
        return { id: row.id, limits: await subscriptionLimits(row, { force: input.refresh === true }), error: "" };
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        return { id: row.id, limits: null, error: LIMIT_ERRORS.has(code) ? code : "UPSTREAM_FAILED" };
      }
    }),
  );
  return { items };
}

export async function startSignIn(kind: string): Promise<SignInStart> {
  const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
  if (!isSignInKind(kind)) throw new Error("UNKNOWN_PROVIDER_KIND");
  const method = signInMethod(kind);
  const device = await startAuthorization(kind);
  return {
    method,
    ticket: sealTicket(session.user.id, device),
    verificationUrl: device.verificationUrl,
    userCode: device.userCode,
    interval: device.interval,
    expiresIn: device.expiresIn,
  };
}

export async function pollSignIn(input: { ticket: string; interval: number }): Promise<SignInPollResult> {
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
}

export async function completeSignIn(input: { ticket: string; code: string }): Promise<SignInPollResult> {
  const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
  const ticket = openTicket(input.ticket, session.user.id);
  if (!ticket) throw new Error("SIGN_IN_EXPIRED");
  if (ticket.grant.kind !== "claude" && ticket.grant.kind !== "antigravity") throw new Error("SIGN_IN_FAILED");
  const completed = await completeAuthorization(ticket.grant, input.code);
  return {
    state: "done",
    credential: sealCredential(session.user.id, ticket.grant.kind, completed),
    account: completed.account,
    plan: completed.plan,
  };
}

type EmptiedGroup = {
  alias: string;
  enabled: boolean;
  billingMode: string;
  overflowGroup: string;
  fallbackGroups: unknown;
  autoRoutes: boolean | null;
  _count: { priceWindows: number };
};

export function catalogOwnedGroups(emptied: EmptiedGroup[], referenced: Set<string>): string[] {
  return emptied
    .filter(
      (group) =>
        group.enabled &&
        group.billingMode === "routed" &&
        group.autoRoutes === null &&
        !group.overflowGroup &&
        asStringArray(group.fallbackGroups).length === 0 &&
        group._count.priceWindows === 0 &&
        !referenced.has(group.alias),
    )
    .map((group) => group.alias);
}

export async function deleteProvider(id: string) {
  const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
  if (!id) throw new Error("MISSING_ID");
  if (!(await prisma.providerConnection.findUnique({ where: { id }, select: { id: true } }))) {
    throw new Error("NOT_FOUND");
  }
  const result = await prisma.$transaction(async (tx) => {
    const routes = await tx.deployment.findMany({ where: { providerId: id }, select: { groupAlias: true } });
    await tx.deployment.deleteMany({ where: { providerId: id } });
    const row = await tx.providerConnection.delete({ where: { id } });
    const touched = [...new Set(routes.map((route) => route.groupAlias))];
    if (!touched.length) return { row, routes: 0, removedGroups: [], emptyGroups: [] };
    const [emptied, others] = await Promise.all([
      tx.modelGroup.findMany({
        where: { alias: { in: touched }, deployments: { none: {} } },
        select: {
          alias: true,
          enabled: true,
          billingMode: true,
          overflowGroup: true,
          fallbackGroups: true,
          autoRoutes: true,
          _count: { select: { priceWindows: true } },
        },
      }),
      tx.modelGroup.findMany({
        where: { alias: { notIn: touched } },
        select: { overflowGroup: true, fallbackGroups: true },
      }),
    ]);
    const referenced = new Set(others.flatMap((group) => [group.overflowGroup, ...asStringArray(group.fallbackGroups)]));
    const removedGroups = catalogOwnedGroups(emptied, referenced);
    if (removedGroups.length) await tx.modelGroup.deleteMany({ where: { alias: { in: removedGroups } } });
    const emptyGroups = emptied.map((group) => group.alias).filter((alias) => !removedGroups.includes(alias));
    return { row, routes: routes.length, removedGroups, emptyGroups };
  });
  await writeAudit({
    actor: session.user.id,
    action: "provider.delete",
    objectType: "provider",
    objectId: result.row.id,
    after: providerAuditAfter(result.row, {
      removedRoutes: result.routes,
      removedGroups: result.removedGroups,
      emptyGroups: result.emptyGroups,
    }),
  });
  await scheduleCatalogTask({ task: "rebuild" });
  return { id: result.row.id, removedRoutes: result.routes, removedGroups: result.removedGroups, emptyGroups: result.emptyGroups };
}

export async function discoverProvider(id: string) {
  const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
  const row = await prisma.providerConnection.findUnique({ where: { id }, include: providerInclude });
  if (!row) throw new Error("NOT_FOUND");
  const refreshed = await refreshProviderModels(row, session.user.id);
  if (refreshed.diff.changed) await scheduleCatalogTask({ task: "rebuild" });
  const provider = publicProvider({ ...refreshed.provider, login: row.login, assignments: row.assignments });
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
}

export async function importProviderModels(input: {
  id: string;
  models: string[];
  strategy?: string;
}) {
  const session = await requirePermission(PERMISSIONS.PROVIDERS_MANAGE);
  const row = await prisma.providerConnection.findUnique({
    where: { id: input.id },
    include: providerInclude,
  });
  if (!row) throw new Error("NOT_FOUND");
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
  return { provider: publicProvider({ ...current, login: row.login, assignments: row.assignments }), added, updated, strategy };
}
