import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import prisma from "@/lib/db/prisma";
import { open, seal } from "@/lib/crypto";
import { staticAuth } from "@/lib/mcp/client";
import { McpError } from "@/lib/mcp/errors";
import {
  MCP_OAUTH_FATAL_ERRORS,
  discoverOAuth,
  manualClient,
  openClient,
  sealClient,
  tokenRequest,
} from "@/lib/mcp/oauth";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { JsonMap } from "@/types/gateway";
import type { McpAuth, McpFetch, McpOAuthClient, McpOAuthLoginState, McpServerRecord, McpTokenGrant } from "@/types/mcp";

const REFRESH_SKEW_MS = 60_000;
const LEASE_MS = 30_000;
const LEASE_WAIT_MS = 10_000;
const LEASE_POLL_MS = 250;
const CLIENT_CREDENTIALS_EXTENSION = "io.modelcontextprotocol/oauth-client-credentials";

const refreshing = new Map<string, Promise<string>>();

type OAuthRecord = Pick<
  McpServerRecord,
  "id" | "url" | "internal" | "authSecret" | "oauthGrant" | "oauthClientId" | "oauthScopes"
>;

type LoginRow = {
  serverId: string;
  issuer: string;
  tokenEndpoint: string;
  resource: string;
  client: string;
  tokens: string;
  scope: string;
  expiresAt: Date | null;
  status: string;
  version: number;
};

export function authHeaders(server: Pick<McpServerRecord, "authType" | "authHeader" | "authSecret">): Record<string, string> {
  const secret = server.authSecret ? open(server.authSecret) : "";
  if (!secret) return {};
  if (server.authType === "bearer") return { Authorization: `Bearer ${secret}` };
  if (server.authType === "header" && server.authHeader) return { [server.authHeader]: secret };
  return {};
}

export function sealTokens(grant: Pick<McpTokenGrant, "access" | "refresh">): string {
  return seal(JSON.stringify({ access: grant.access, refresh: grant.refresh }));
}

function loginOf(row: LoginRow): McpOAuthLoginState | null {
  const client = openClient(row.client);
  const tokens = parseJsonOrNull(open(row.tokens)) as JsonMap | null;
  if (!client || !tokens) {
    logger.warn("mcp.oauth_login_unreadable", { serverId: row.serverId });
    return null;
  }
  return {
    issuer: row.issuer,
    tokenEndpoint: row.tokenEndpoint,
    resource: row.resource,
    client,
    tokens: {
      access: typeof tokens.access === "string" ? tokens.access : "",
      refresh: typeof tokens.refresh === "string" ? tokens.refresh : "",
    },
    scope: row.scope,
    expiresAt: row.expiresAt?.getTime() ?? null,
    version: row.version,
  };
}

function usable(state: McpOAuthLoginState, stale: string, now = Date.now()): boolean {
  if (!state.tokens.access || state.tokens.access === stale) return false;
  return state.expiresAt === null || state.expiresAt - now > REFRESH_SKEW_MS;
}

function stillValid(state: McpOAuthLoginState, stale: string, now = Date.now()): boolean {
  return Boolean(state.tokens.access) && state.tokens.access !== stale && (state.expiresAt === null || state.expiresAt > now);
}

function fatal(err: unknown): boolean {
  return err instanceof McpError && err.code === "MCP_OAUTH_TOKEN" && MCP_OAUTH_FATAL_ERRORS.has(err.detail);
}

export function loginData(input: {
  issuer: string;
  tokenEndpoint: string;
  resource: string;
  client: McpOAuthClient;
  grant: McpTokenGrant;
  scope: string;
}) {
  return {
    issuer: input.issuer,
    tokenEndpoint: input.tokenEndpoint,
    resource: input.resource,
    client: sealClient(input.client),
    tokens: sealTokens(input.grant),
    scope: input.grant.scope || input.scope,
    expiresAt: input.grant.expiresAt,
    status: "active",
    leaseUntil: null,
  };
}

async function requestClientCredentials(record: OAuthRecord, fetch: McpFetch, current: McpOAuthLoginState | null) {
  const discovered = current
    ? null
    : await discoverOAuth({ url: record.url, scopes: record.oauthScopes, previousScope: "", offline: false }, fetch);
  const issuer = current?.issuer ?? discovered!.server.issuer;
  const tokenEndpoint = current?.tokenEndpoint ?? discovered!.server.tokenEndpoint;
  const resource = current?.resource ?? discovered!.resource;
  const scope = record.oauthScopes || current?.scope || discovered?.scope || "";
  const client = manualClient(
    { clientId: record.oauthClientId, sealedSecret: record.authSecret, redirectUri: "" },
    { tokenAuthMethods: discovered?.server.tokenAuthMethods ?? [] },
  );
  if (current && current.client.clientId === client.clientId) client.authMethod = current.client.authMethod;
  if (!client.clientId || !client.clientSecret) throw new McpError("MCP_OAUTH_CLIENT_REQUIRED");
  const grant = await tokenRequest(fetch, tokenEndpoint, client, {
    grant_type: "client_credentials",
    resource,
    scope,
  });
  return { issuer, tokenEndpoint, resource, client, grant, scope };
}

async function issueClientCredentials(record: OAuthRecord, fetch: McpFetch, current: McpOAuthLoginState | null): Promise<string> {
  const issued = await requestClientCredentials(record, fetch, current);
  const data = loginData(issued);
  await prisma.mcpOAuthLogin.upsert({
    where: { serverId: record.id },
    create: { serverId: record.id, ...data },
    update: { ...data, version: { increment: 1 } },
  });
  return issued.grant.access;
}

export function trialClientCredentials(record: OAuthRecord, fetch: McpFetch): McpAuth {
  let token: Promise<string> | null = null;
  return {
    async headers() {
      token ??= requestClientCredentials(record, fetch, null).then((issued) => issued.grant.access);
      return { Authorization: `Bearer ${await token}` };
    },
    async rejected() {
      return false;
    },
  };
}

async function renew(record: OAuthRecord, row: LoginRow, state: McpOAuthLoginState, fetch: McpFetch, stale: string): Promise<string> {
  try {
    if (!state.tokens.refresh) {
      if (record.oauthGrant !== "client_credentials") throw new McpError("MCP_OAUTH_TOKEN", "invalid_grant");
      return await issueClientCredentials(record, fetch, state);
    }
    const grant = await tokenRequest(fetch, state.tokenEndpoint, state.client, {
      grant_type: "refresh_token",
      refresh_token: state.tokens.refresh,
      resource: state.resource,
    });
    await prisma.mcpOAuthLogin.update({
      where: { serverId: row.serverId },
      data: {
        tokens: sealTokens({ access: grant.access, refresh: grant.refresh || state.tokens.refresh }),
        scope: grant.scope || state.scope,
        expiresAt: grant.expiresAt,
        leaseUntil: null,
        version: { increment: 1 },
      },
    });
    return grant.access;
  } catch (err) {
    const expired = fatal(err);
    await prisma.mcpOAuthLogin.updateMany({
      where: { serverId: row.serverId, version: row.version },
      data: { leaseUntil: null, ...(expired ? { status: "expired" } : {}) },
    });
    logger.warn("mcp.oauth_refresh_failed", {
      serverId: row.serverId,
      fatal: expired,
      ...(err instanceof McpError ? { code: err.code, detail: err.detail } : errorFields(err)),
    });
    if (!expired && stillValid(state, stale)) return state.tokens.access;
    throw expired ? new McpError("MCP_AUTH_REQUIRED") : err;
  }
}

async function refreshLogin(record: OAuthRecord, fetch: McpFetch, stale: string): Promise<string> {
  const deadline = Date.now() + LEASE_WAIT_MS;
  for (;;) {
    const row = await prisma.mcpOAuthLogin.findUnique({ where: { serverId: record.id } });
    const state = row && row.status === "active" ? loginOf(row) : null;
    if (!row || !state) {
      if (record.oauthGrant === "client_credentials") return issueClientCredentials(record, fetch, null);
      throw new McpError("MCP_AUTH_REQUIRED");
    }
    if (usable(state, stale)) return state.tokens.access;
    const now = new Date();
    const claimed = await prisma.mcpOAuthLogin.updateMany({
      where: {
        serverId: record.id,
        version: row.version,
        status: "active",
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count === 1) return renew(record, row, state, fetch, stale);
    if (Date.now() > deadline) {
      if (stillValid(state, stale)) return state.tokens.access;
      throw new McpError("MCP_TIMEOUT", "token refresh");
    }
    await delay(LEASE_POLL_MS);
  }
}

export async function oauthAccessToken(record: OAuthRecord, fetch: McpFetch, stale = ""): Promise<string> {
  const row = await prisma.mcpOAuthLogin.findUnique({ where: { serverId: record.id } });
  const state = row && row.status === "active" ? loginOf(row) : null;
  if (state && usable(state, stale)) return state.tokens.access;
  if (!state && record.oauthGrant !== "client_credentials") throw new McpError("MCP_AUTH_REQUIRED");
  const key = `${record.id}:${stale}`;
  const pending = refreshing.get(key);
  if (pending) return pending;
  const started = refreshLogin(record, fetch, stale).finally(() => refreshing.delete(key));
  refreshing.set(key, started);
  return started;
}

export function mcpAuthFor(record: OAuthRecord & Pick<McpServerRecord, "authType" | "authHeader">, fetch: McpFetch): McpAuth {
  if (record.authType !== "oauth") return staticAuth(authHeaders(record));
  let used = "";
  return {
    async headers() {
      used = await oauthAccessToken(record, fetch);
      return { Authorization: `Bearer ${used}` };
    },
    async rejected() {
      if (!used) return false;
      const stale = used;
      return (await oauthAccessToken(record, fetch, stale)) !== stale;
    },
  };
}

export function mcpCapabilities(record: Pick<McpServerRecord, "authType" | "oauthGrant">): JsonMap | undefined {
  if (record.authType !== "oauth" || record.oauthGrant !== "client_credentials") return undefined;
  return { extensions: { [CLIENT_CREDENTIALS_EXTENSION]: {} } };
}
