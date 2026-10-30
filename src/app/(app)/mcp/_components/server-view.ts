import type { McpServerView } from "@/types/mcp";

export const SERVER_FILTERS = ["all", "connected", "attention", "disabled"] as const;

export type ServerFilter = (typeof SERVER_FILTERS)[number];

export function serverFilterOf(value: string | null | undefined): ServerFilter {
  return SERVER_FILTERS.find((filter) => filter === value) ?? "all";
}

export function inFilter(server: McpServerView, filter: ServerFilter): boolean {
  if (filter === "connected") return server.status === "connected";
  if (filter === "attention") return server.status === "error" || server.status === "signin";
  if (filter === "disabled") return !server.enabled;
  return true;
}

export function matchesQuery(server: McpServerView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [server.name, server.description, server.url].some((value) => value.toLowerCase().includes(needle));
}

export function enabledTools(server: McpServerView): number {
  if (!server.toolsRestricted) return server.tools.length;
  return server.tools.filter((tool) => server.allowedTools.includes(tool.name)).length;
}

export function accessOf(server: McpServerView): { first: string; allowed: number; blocks: number } {
  const allowed = server.assignments.filter((rule) => rule.mode === "allow");
  return {
    first: allowed[0]?.label ?? "",
    allowed: allowed.length,
    blocks: server.assignments.length - allowed.length,
  };
}

export function companyConnected(server: McpServerView, companyId: string | null): boolean {
  const installation = companyId ? server.installations.find((row) => row.orgId === companyId) : null;
  return Boolean(installation?.enabled && (installation.authType === "none" || installation.hasSecret));
}
