import "server-only";
import prisma from "@/lib/db/prisma";
import { hostedAuth, mcpAuthFor, mcpCapabilities } from "@/lib/mcp/auth";
import { McpClient, toolSpecs } from "@/lib/mcp/client";
import { callHosted, hostedSpec } from "@/lib/mcp/hosted";
import { chainOf, classifyTools, effectiveServers, toolActionsOf } from "@/lib/mcp/resolve";
import { bindTools } from "@/lib/mcp/tool-names";
import { guardedFetch } from "@/lib/mcp/transport";
import { MCP_STATIC_AUTH_TYPES, authUsesName } from "@/schemas/mcp";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type { Principal } from "@/types/gateway";
import type {
  McpAssignmentMode,
  McpAuth,
  McpAuthType,
  McpChain,
  McpConnection,
  McpExecutor,
  McpFetch,
  McpOAuthGrant,
  McpServerRecord,
  McpStaticAuthType,
  McpToolset,
  McpTransport,
} from "@/types/mcp";

export const MCP_OPT_OUT_HEADER = "x-llmhub-mcp";

const OPT_OUT_VALUES = new Set(["off", "0", "false", "none", "disabled"]);

export function mcpOptedOut(headers: Headers): boolean {
  return OPT_OUT_VALUES.has(headers.get(MCP_OPT_OUT_HEADER)?.trim().toLowerCase() ?? "");
}

export function isStaticAuthType(value: string): value is McpStaticAuthType {
  return MCP_STATIC_AUTH_TYPES.some((type) => type === value);
}

export function installedAuthType(value: string): McpStaticAuthType {
  return isStaticAuthType(value) ? value : "bearer";
}

export function isAuthType(value: string): value is McpAuthType {
  return isStaticAuthType(value) || value === "oauth";
}

export function isOAuthGrant(value: string): value is McpOAuthGrant {
  return value === "authorization_code" || value === "client_credentials";
}

export function isTransport(value: string): value is McpTransport {
  return value === "streamable_http" || value === "sse";
}

export function isAssignmentMode(value: string): value is McpAssignmentMode {
  return value === "allow" || value === "block";
}

export function serverRecord(row: {
  id: string;
  name: string;
  url: string;
  authType: string;
  authHeader: string;
  authSecret: string;
  internal: boolean;
  oauthGrant: string;
  oauthClientId: string;
  oauthScopes: string;
  transport: string;
  protocolVersion: string;
  kind?: string;
  spec?: unknown;
}): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    authType: isAuthType(row.authType) ? row.authType : "none",
    authHeader: row.authHeader,
    authSecret: row.authSecret,
    internal: row.internal,
    oauthGrant: isOAuthGrant(row.oauthGrant) ? row.oauthGrant : "authorization_code",
    oauthClientId: row.oauthClientId,
    oauthScopes: row.oauthScopes,
    transport: isTransport(row.transport) ? row.transport : "streamable_http",
    protocolVersion: row.protocolVersion,
    kind: row.kind === "hosted" ? "hosted" : "remote",
    spec: hostedSpec(row.spec),
  };
}

export function connectionOf(record: Pick<McpServerRecord, "transport" | "protocolVersion">): McpConnection {
  return { transport: record.transport, protocolVersion: record.protocolVersion };
}

export function mcpClientFor(
  record: McpServerRecord,
  fetch: McpFetch,
  options: { timeoutMs?: number; auth?: McpAuth } = {},
): McpClient {
  return new McpClient({
    url: record.url,
    fetch,
    auth: options.auth ?? mcpAuthFor(record, fetch),
    connection: connectionOf(record),
    capabilities: mcpCapabilities(record),
    timeoutMs: options.timeoutMs,
  });
}

export async function rememberConnection(serverId: string, connection: McpConnection): Promise<void> {
  await prisma.mcpServer.updateMany({ where: { id: serverId }, data: connection });
}

function chainConditions(chain: McpChain) {
  return [
    ...(chain.orgId ? [{ orgId: chain.orgId }] : []),
    ...(chain.teamId ? [{ teamId: chain.teamId }] : []),
    ...(chain.projectId ? [{ projectId: chain.projectId }] : []),
    ...(chain.memberId ? [{ memberId: chain.memberId }] : []),
    ...(chain.keyId ? [{ keyId: chain.keyId }] : []),
  ];
}

function signedIn(row: { authType: string; oauthGrant: string; oauthLogin?: { status: string } | null }): boolean {
  if (row.authType !== "oauth" || row.oauthGrant === "client_credentials") return true;
  return row.oauthLogin?.status === "active";
}

export async function loadMcpServers(chain: McpChain) {
  const conditions = chainConditions(chain);
  const rows = await prisma.mcpServer.findMany({
    where: {
      enabled: true,
      OR: [{ global: true }, ...(conditions.length ? [{ assignments: { some: { mode: "allow", OR: conditions } } }] : [])],
    },
    select: {
      id: true,
      name: true,
      url: true,
      authType: true,
      authHeader: true,
      authSecret: true,
      oauthGrant: true,
      oauthClientId: true,
      oauthScopes: true,
      transport: true,
      protocolVersion: true,
      kind: true,
      spec: true,
      internal: true,
      enabled: true,
      global: true,
      template: true,
      toolsRestricted: true,
      allowedTools: true,
      tools: true,
      toolActions: true,
      oauthLogin: { select: { status: true } },
      installations: {
        where: { orgId: chain.orgId || "__none__", enabled: true },
        select: { baseUrl: true, authType: true, authHeader: true, authSecret: true },
      },
      assignments: {
        where: conditions.length ? { OR: conditions } : { id: "__none__" },
        select: {
          serverId: true,
          orgId: true,
          teamId: true,
          projectId: true,
          memberId: true,
          keyId: true,
          mode: true,
          blockedTools: true,
          blockedActions: true,
          role: { select: { allActions: true, actions: true, tools: true, deniedTools: true } },
        },
      },
    },
    orderBy: { name: "asc" },
  });
  const records = new Map<string, McpServerRecord>();
  for (const row of rows) records.set(row.id, serverRecord(row));
  const servers = effectiveServers(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      global: row.global,
      enabled: row.enabled && signedIn(row),
      toolsRestricted: row.toolsRestricted,
      allowedTools: row.allowedTools,
      tools: classifyTools(toolSpecs(row.tools), toolActionsOf(row.toolActions)),
    })),
    rows.flatMap((row) =>
      row.assignments.map((rule) => ({
        ...rule,
        mode: isAssignmentMode(rule.mode) ? rule.mode : "block",
        blockedActions: Array.isArray(rule.blockedActions) ? rule.blockedActions : [],
        role: rule.role
          ? {
              allActions: rule.role.allActions,
              actions: rule.role.actions,
              tools: rule.role.tools,
              deniedTools: rule.role.deniedTools,
            }
          : null,
      })),
    ),
    chain,
  );
  const offered = new Map(rows.map((row) => [row.id, row]));
  const visible = servers.filter((server) => {
    const row = offered.get(server.serverId);
    const record = records.get(server.serverId);
    if (!row || !record || !row.template) return true;
    const installation = row.installations[0];
    if (!installation) return false;
    if (record.kind !== "hosted") return true;
    const authType = installedAuthType(installation.authType);
    if (authType !== "none" && !installation.authSecret) return false;
    records.set(server.serverId, {
      ...record,
      url: installation.baseUrl || record.url,
      authType,
      authHeader: authUsesName(authType) ? installation.authHeader : "",
      authSecret: installation.authSecret,
    });
    return true;
  });
  return { servers: visible, records };
}

function changed(record: McpServerRecord, connection: McpConnection | null): connection is McpConnection {
  return Boolean(
    connection && (connection.transport !== record.transport || connection.protocolVersion !== record.protocolVersion),
  );
}

export function createExecutor(
  records: Map<string, McpServerRecord>,
  fetchFor: (internal: boolean) => McpFetch = guardedFetch,
  remember: (serverId: string, connection: McpConnection) => Promise<void> = rememberConnection,
): McpExecutor {
  const sessions = new Map<string, McpClient>();
  const session = (record: McpServerRecord) => {
    const existing = sessions.get(record.id);
    if (existing) return existing;
    const client = mcpClientFor(record, fetchFor(record.internal));
    sessions.set(record.id, client);
    return client;
  };
  return {
    async call(bound, args, signal) {
      const record = records.get(bound.serverId);
      if (!record) return { text: "This tool is no longer available.", isError: true };
      if (record.kind === "hosted") {
        return callHosted(record.url, record.internal, record.spec, bound.tool.name, args, signal, fetchFor(record.internal), hostedAuth(record));
      }
      return session(record).callTool(bound.tool.name, args, signal, bound.tool.inputSchema);
    },
    async close() {
      const open = [...sessions.entries()];
      sessions.clear();
      await Promise.all(open.map(([, client]) => client.close()));
      for (const [serverId, client] of open) {
        const record = records.get(serverId);
        const connection = client.connection;
        if (!record || !changed(record, connection)) continue;
        await remember(serverId, connection).catch((err) => {
          logger.warn("mcp.connection_store_failed", { serverId, ...errorFields(err) });
        });
      }
    },
  };
}

export async function mcpToolsetFor(
  req: Request,
  principal: Principal,
  reservedNames: Iterable<string>,
): Promise<McpToolset | null> {
  if (mcpOptedOut(req.headers)) return null;
  const { servers, records } = await loadMcpServers(chainOf(principal));
  const tools = bindTools(servers, reservedNames);
  if (!tools.length) return null;
  return { tools, byName: new Map(tools.map((tool) => [tool.name, tool])), executor: createExecutor(records) };
}
