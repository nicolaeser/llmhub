import "server-only";
import { ensureMcpRoles, saveMcpInstallation, saveMcpPermissions, setMcpTemplate } from "@/lib/mcp/catalog";
import { presentMcpServer } from "@/lib/mcp/servers";

export async function ensureServerRoles(id: string) {
  const saved = await ensureMcpRoles(id);
  return presentMcpServer(saved.serverId);
}

export async function saveServerPermissions(input: unknown) {
  const saved = await saveMcpPermissions(input);
  return presentMcpServer(saved.serverId);
}

export async function saveServerTemplate(input: unknown) {
  const saved = await setMcpTemplate(input);
  return presentMcpServer(saved.serverId);
}

export async function saveServerInstallation(input: unknown) {
  const saved = await saveMcpInstallation(input);
  return presentMcpServer(saved.serverId);
}
