import "server-only";
import type { ZodType } from "zod";
import prisma from "@/lib/db/prisma";
import { requestMeta } from "@/lib/auth/session";
import { assertRequestRate } from "@/lib/auth/throttle";
import { env } from "@/lib/env";
import { antigravityClientSecret } from "@/lib/gateway/upstreams/antigravity-config";
import { isSignInKind, signInKinds, signInMethod } from "@/lib/gateway/upstreams/provider-kinds";
import {
  completeAuthorization,
  openTicket,
  pollDeviceCode,
  sealTicket,
  startAuthorization,
} from "@/lib/gateway/upstreams/subscription-sign-in";
import { isActionCode } from "@/lib/http/action-result";
import { clientBucket } from "@/lib/http/client-ip";
import { subAddRemaining, subAddStatus } from "@/lib/providers/sub-add-status";
import {
  newSubAddToken,
  removeSubAddAccount,
  storeSubAddAccount,
  SUB_ADD_UNAVAILABLE,
  subAddAccountSelect,
  subAddAccountViews,
  subAddTokenHash,
  subAddUid,
} from "@/lib/providers/sub-add-store";
import {
  subAddCompleteSchema,
  subAddManageSchema,
  subAddOpenSchema,
  subAddPollSchema,
  subAddRemoveSchema,
  subAddStartSchema,
} from "@/schemas/sub-add";
import type { SignInKind, SignInSession, SignInStart } from "@/types/providers";
import type { SubAddContributions, SubAddLinkRecord, SubAddOffer, SubAddStep } from "@/types/sub-add";

const MINUTE_MS = 60_000;
const CLIENT_REQUESTS_PER_MINUTE = 60;
const SIGN_IN_WINDOW_MS = 15 * MINUTE_MS;
const CLIENT_SIGN_INS = 10;
const LINK_SIGN_INS = 30;
const CLIENT_COMPLETIONS = 10;
const CLIENT_REMOVALS = 20;
const SLOW_DOWN_STEP_S = 5;
const TOKEN_FIELDS = new Set<PropertyKey>(["token", "manage"]);
const PUBLIC_CODES = new Set([
  SUB_ADD_UNAVAILABLE,
  "SIGN_IN_EXPIRED",
  "SIGN_IN_DENIED",
  "SIGN_IN_FAILED",
  "ANTIGRAVITY_NO_PROJECT",
  "RATE_LIMITED",
  "VALIDATION",
  "NOT_FOUND",
]);

function parseInput<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const tokenIssue = parsed.error.issues.some((issue) => TOKEN_FIELDS.has(issue.path[0] ?? ""));
  throw new Error(tokenIssue ? SUB_ADD_UNAVAILABLE : "VALIDATION");
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (!isActionCode(code)) throw error;
    throw new Error(PUBLIC_CODES.has(code) ? code : SUB_ADD_UNAVAILABLE, { cause: error });
  }
}

async function throttledClient(): Promise<string> {
  const { ipAddress } = await requestMeta();
  const client = clientBucket(ipAddress);
  await assertRequestRate(`sub-add:client:${client}`, CLIENT_REQUESTS_PER_MINUTE, MINUTE_MS);
  return client;
}

async function throttle(scope: string, limit: number): Promise<void> {
  await assertRequestRate(`sub-add:${scope}`, limit, SIGN_IN_WINDOW_MS);
}

function instanceName(): string {
  return URL.canParse(env.NEXT_PUBLIC_APP_URL) ? new URL(env.NEXT_PUBLIC_APP_URL).host : "";
}

async function kindReady(kind: SignInKind): Promise<boolean> {
  return kind !== "antigravity" || Boolean(await antigravityClientSecret());
}

async function offeredKinds(kinds: string[]): Promise<SignInKind[]> {
  const allowed = signInKinds().filter((kind) => kinds.includes(kind));
  const ready = await Promise.all(allowed.map(kindReady));
  return allowed.filter((_, index) => ready[index]);
}

async function usableLink(token: string, now = Date.now()): Promise<SubAddLinkRecord> {
  const link = await prisma.subAddLink.findUnique({
    where: { tokenHash: subAddTokenHash(token) },
    select: { id: true, label: true, kinds: true, expiresAt: true, revokedAt: true, maxAccounts: true, added: true },
  });
  if (!link || subAddStatus(link, now) !== "active") throw new Error(SUB_ADD_UNAVAILABLE);
  return link;
}

async function manageFor(manage: string | undefined): Promise<{ token: string; hash: string }> {
  if (manage) {
    const hash = subAddTokenHash(manage);
    if (await prisma.subAddAccount.count({ where: { manageHash: hash } })) return { token: manage, hash };
  }
  return newSubAddToken();
}

async function finish(
  link: SubAddLinkRecord,
  kind: SignInKind,
  session: SignInSession,
  manage: string | undefined,
): Promise<SubAddStep> {
  const owner = await manageFor(manage);
  const stored = await storeSubAddAccount({ linkId: link.id, kind, session, manageHash: owner.hash });
  return {
    state: "done",
    kind,
    account: session.account,
    plan: session.plan,
    outcome: stored.outcome,
    manageToken: owner.token,
  };
}

function ticketFor(link: SubAddLinkRecord, value: string) {
  const ticket = openTicket(value, subAddUid(link.id));
  if (!ticket) throw new Error("SIGN_IN_EXPIRED");
  if (!link.kinds.includes(ticket.grant.kind)) throw new Error(SUB_ADD_UNAVAILABLE);
  return ticket;
}

export async function openSubAddLink(raw: unknown): Promise<SubAddOffer> {
  return guarded(async () => {
    await throttledClient();
    const { token } = parseInput(subAddOpenSchema, raw);
    const link = await usableLink(token);
    const kinds = await offeredKinds(link.kinds);
    if (!kinds.length) throw new Error(SUB_ADD_UNAVAILABLE);
    return {
      label: link.label,
      instance: instanceName(),
      kinds,
      remaining: subAddRemaining(link),
      expiresAt: link.expiresAt.toISOString(),
    };
  });
}

export async function startSubAddSignIn(raw: unknown): Promise<SignInStart> {
  return guarded(async () => {
    const client = await throttledClient();
    const input = parseInput(subAddStartSchema, raw);
    const link = await usableLink(input.token);
    await throttle(`start:${client}`, CLIENT_SIGN_INS);
    await throttle(`start-link:${link.id}`, LINK_SIGN_INS);
    const kind = input.kind;
    if (!isSignInKind(kind) || !link.kinds.includes(kind) || !(await kindReady(kind))) {
      throw new Error(SUB_ADD_UNAVAILABLE);
    }
    const device = await startAuthorization(kind);
    return {
      method: signInMethod(kind),
      ticket: sealTicket(subAddUid(link.id), device),
      verificationUrl: device.verificationUrl,
      userCode: device.userCode,
      interval: device.interval,
      expiresIn: device.expiresIn,
    };
  });
}

export async function pollSubAddSignIn(raw: unknown): Promise<SubAddStep> {
  return guarded(async () => {
    await throttledClient();
    const input = parseInput(subAddPollSchema, raw);
    const link = await usableLink(input.token);
    const ticket = ticketFor(link, input.ticket);
    const polled = await pollDeviceCode(ticket.grant);
    if (polled.state === "denied") throw new Error("SIGN_IN_DENIED");
    if (polled.state === "expired") throw new Error("SIGN_IN_EXPIRED");
    if (polled.state === "pending") {
      const interval = Math.max(ticket.interval, Math.round(input.interval) || ticket.interval);
      return { state: "pending", interval: polled.slowDown ? interval + SLOW_DOWN_STEP_S : interval };
    }
    return finish(link, ticket.grant.kind, polled.session, input.manage);
  });
}

export async function completeSubAddSignIn(raw: unknown): Promise<SubAddStep> {
  return guarded(async () => {
    const client = await throttledClient();
    await throttle(`complete:${client}`, CLIENT_COMPLETIONS);
    const input = parseInput(subAddCompleteSchema, raw);
    const link = await usableLink(input.token);
    const ticket = ticketFor(link, input.ticket);
    if (ticket.grant.kind !== "claude" && ticket.grant.kind !== "antigravity") throw new Error("SIGN_IN_FAILED");
    const session = await completeAuthorization(ticket.grant, input.code);
    return finish(link, ticket.grant.kind, session, input.manage);
  });
}

async function contributions(manageHash: string): Promise<SubAddContributions> {
  const rows = await prisma.subAddAccount.findMany({
    where: { manageHash },
    select: subAddAccountSelect,
    orderBy: { createdAt: "asc" },
  });
  return { instance: instanceName(), accounts: subAddAccountViews(rows) };
}

export async function loadSubAddContributions(raw: unknown): Promise<SubAddContributions> {
  return guarded(async () => {
    await throttledClient();
    const { manage } = parseInput(subAddManageSchema, raw);
    return contributions(subAddTokenHash(manage));
  });
}

export async function removeSubAddContribution(raw: unknown): Promise<SubAddContributions> {
  return guarded(async () => {
    const client = await throttledClient();
    await throttle(`remove:${client}`, CLIENT_REMOVALS);
    const input = parseInput(subAddRemoveSchema, raw);
    const manageHash = subAddTokenHash(input.manage);
    await removeSubAddAccount(input.providerId, manageHash);
    return contributions(manageHash);
  });
}
