import "server-only";
import prisma from "@/lib/db/prisma";
import { open } from "@/lib/crypto";
import { McpClient, toolSpecs } from "@/lib/mcp/client";
import { chainOf, effectiveServers } from "@/lib/mcp/resolve";
import { bindTools } from "@/lib/mcp/tool-names";
import { guardedFetch } from "@/lib/mcp/transport";
import type { Principal } from "@/types/gateway";
import type {
  McpAssignmentMode,
  McpAuthType,
  McpChain,
  McpExecutor,
  McpFetch,
  McpServerRecord,
  McpToolset,
} from "@/types/mcp";

export const MCP_OPT_OUT_HEADER = "x-llmhub-mcp";

const OPT_OUT_VALUES = new Set(["off", "0", "false", "none", "disabled"]);

export function mcpOptedOut(headers: Headers): boolean {
  return OPT_OUT_VALUES.has(headers.get(MCP_OPT_OUT_HEADER)?.trim().toLowerCase() ?? "");
}

export function isAuthType(value: string): value is McpAuthType {
  return value === "none" || value === "bearer" || value === "header";
}

export function isAssignmentMode(value: string): value is McpAssignmentMode {
  return value === "allow" || value === "block";
}

export function authHeaders(server: Pick<McpServerRecord, "authType" | "authHeader" | "authSecret">): Record<string, string> {
  const secret = server.authSecret ? open(server.authSecret) : "";
  if (!secret) return {};
  if (server.authType === "bearer") return { Authorization: `Bearer ${secret}` };
  if (server.authType === "header" && server.authHeader) return { [server.authHeader]: secret };
  return {};
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
      internal: true,
      enabled: true,
      global: true,
      toolsRestricted: true,
      allowedTools: true,
      tools: true,
      assignments: {
        where: { OR: conditions },
        select: {
          serverId: true,
          orgId: true,
          teamId: true,
          projectId: true,
          memberId: true,
          keyId: true,
          mode: true,
          blockedTools: true,
        },
      },
    },
    orderBy: { name: "asc" },
  });
  const records = new Map<string, McpServerRecord>();
  for (const row of rows) {
    records.set(row.id, {
      id: row.id,
      name: row.name,
      url: row.url,
      authType: isAuthType(row.authType) ? row.authType : "none",
      authHeader: row.authHeader,
      authSecret: row.authSecret,
      internal: row.internal,
    });
  }
  const servers = effectiveServers(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      global: row.global,
      enabled: row.enabled,
      toolsRestricted: row.toolsRestricted,
      allowedTools: row.allowedTools,
      tools: toolSpecs(row.tools),
    })),
    rows.flatMap((row) =>
      row.assignments.map((rule) => ({ ...rule, mode: isAssignmentMode(rule.mode) ? rule.mode : "block" })),
    ),
    chain,
  );
  return { servers, records };
}

export function createExecutor(
  records: Map<string, McpServerRecord>,
  fetchFor: (internal: boolean) => McpFetch = guardedFetch,
): McpExecutor {
  const sessions = new Map<string, McpClient>();
  const session = (record: McpServerRecord) => {
    const existing = sessions.get(record.id);
    if (existing) return existing;
    const client = new McpClient({ url: record.url, headers: authHeaders(record), fetch: fetchFor(record.internal) });
    sessions.set(record.id, client);
    return client;
  };
  return {
    async call(bound, args, signal) {
      const record = records.get(bound.serverId);
      if (!record) return { text: "This tool is no longer available.", isError: true };
      return session(record).callTool(bound.tool.name, args, signal);
    },
    async close() {
      await Promise.all([...sessions.values()].map((client) => client.close()));
      sessions.clear();
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
