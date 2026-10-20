import "server-only";
import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { trialClientCredentials } from "@/lib/mcp/auth";
import { eraOf } from "@/lib/mcp/client";
import { McpError, mcpErrorCode, type McpErrorCode } from "@/lib/mcp/errors";
import { discoverOAuth } from "@/lib/mcp/oauth";
import { connectionFields, parse, secretFor } from "@/lib/mcp/server-input";
import { loadRow, scopedView, serverSelect, type ServerRow } from "@/lib/mcp/server-view";
import { mcpClientFor, serverRecord } from "@/lib/mcp/toolset";
import { guardedFetch } from "@/lib/mcp/transport";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { mcpProbeSchema } from "@/schemas/mcp";
import type { Prisma } from "@/generated/prisma/client";
import type { McpAuth, McpProbeResult, McpServerRecord } from "@/types/mcp";

const PROBE_TIMEOUT_MS = 20_000;

function failedProbe(error: McpErrorCode): McpProbeResult {
  return { connected: false, tools: [], serverName: "", error, transport: null, protocolVersion: "", era: null };
}

function probeCode(err: unknown, record: Pick<McpServerRecord, "authType">): McpErrorCode {
  const code = mcpErrorCode(err);
  if (code !== "MCP_AUTH_FAILED" || record.authType === "oauth" || !(err instanceof McpError)) return code;
  if (err.challenge) return "MCP_OAUTH_SUGGESTED";
  return record.authType === "none" ? "MCP_AUTH_REQUIRED" : code;
}

export async function probe(record: McpServerRecord, auth?: McpAuth): Promise<McpProbeResult> {
  const client = mcpClientFor(record, guardedFetch(record.internal), { timeoutMs: PROBE_TIMEOUT_MS, auth });
  try {
    const serverName = await client.discover();
    const tools = await client.listTools(undefined, (tool, reason) => {
      logger.warn("mcp.tool_rejected", { serverId: record.id, tool, reason });
    });
    const connection = client.connection;
    return {
      connected: true,
      tools,
      serverName,
      error: "",
      transport: connection?.transport ?? null,
      protocolVersion: connection?.protocolVersion ?? "",
      era: eraOf(connection),
    };
  } catch (err) {
    const code = probeCode(err, record);
    logger.warn("mcp.probe_failed", { code, ...(err instanceof McpError ? {} : errorFields(err)) });
    return failedProbe(code);
  } finally {
    await client.close();
  }
}

export async function storeProbe(id: string, result: McpProbeResult): Promise<ServerRow> {
  return prisma.mcpServer.update({
    where: { id },
    data: result.connected
      ? {
          tools: result.tools as unknown as Prisma.InputJsonValue,
          refreshedAt: new Date(),
          lastError: "",
          ...(result.transport ? { transport: result.transport, protocolVersion: result.protocolVersion } : {}),
        }
      : { lastError: result.error },
    select: serverSelect,
  });
}

export async function probeMcpServer(raw: unknown): Promise<McpProbeResult> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(mcpProbeSchema, raw);
  const verdict = checkServerUrl(input.url, input.internal);
  if (!verdict.ok) return failedProbe(verdict.code);
  const stored = input.id ? await prisma.mcpServer.findUnique({ where: { id: input.id }, select: serverSelect }) : null;
  const sameUrl = stored?.url === input.url;
  const storedSecret = stored?.authType === input.authType ? stored.authSecret : "";
  const authSecret = secretFor(input.authType, { secret: input.secret }, storedSecret);
  const record = serverRecord({
    id: stored?.id ?? "",
    name: stored?.name ?? "",
    url: input.url,
    authType: input.authType,
    authSecret,
    internal: input.internal,
    ...connectionFields(input),
    transport: sameUrl && stored ? stored.transport : "streamable_http",
    protocolVersion: sameUrl && stored ? stored.protocolVersion : "",
  });
  if (record.authType !== "oauth") return probe(record);
  const fetch = guardedFetch(record.internal);
  if (record.oauthGrant === "client_credentials") return probe(record, trialClientCredentials(record, fetch));
  const signedIn = sameUrl && stored?.authType === "oauth" && stored.oauthLogin?.status === "active";
  if (signedIn) return probe(record);
  try {
    await discoverOAuth({ url: record.url, scopes: record.oauthScopes, previousScope: "", offline: true }, fetch);
    return failedProbe("MCP_AUTH_REQUIRED");
  } catch (err) {
    return failedProbe(mcpErrorCode(err));
  }
}

export async function refreshMcpServer(id: string) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  if (!id) throw new Error("MISSING_ID");
  const row = await loadRow(id);
  if (row.kind === "hosted") return { server: scopedView(row, session) };
  const result = await probe(serverRecord(row));
  const updated = await storeProbe(id, result);
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.refresh",
    objectType: "mcp_server",
    objectId: id,
    after: { connected: result.connected, tools: result.tools.length, error: result.error },
  });
  return { server: scopedView(updated, session) };
}
