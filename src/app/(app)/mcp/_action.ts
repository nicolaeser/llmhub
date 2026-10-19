"use server";

import { runAction } from "@/lib/http/action-result";
import { ensureMcpRoles, saveMcpInstallation, saveMcpPermissions, setMcpTemplate } from "@/lib/mcp/catalog";
import { setBuilderModel } from "@/lib/mcp/builder";
import {
  createHostedMcpServer,
  createMcpServer,
  deleteMcpServer,
  disconnectMcpOAuth,
  loadMcpServerList,
  loadMcpTargets,
  presentMcpServer,
  probeMcpServer,
  refreshMcpServer,
  saveMcpAssignments,
  setMcpServerEnabled,
  startMcpOAuth,
  updateMcpServer,
} from "@/lib/mcp/servers";

export async function loadMcpServersAction(...args: Parameters<typeof loadMcpServerList>) {
  return runAction(() => loadMcpServerList(...args));
}

export async function createMcpServerAction(...args: Parameters<typeof createMcpServer>) {
  return runAction(() => createMcpServer(...args));
}

export async function updateMcpServerAction(...args: Parameters<typeof updateMcpServer>) {
  return runAction(() => updateMcpServer(...args));
}

export async function setMcpServerEnabledAction(...args: Parameters<typeof setMcpServerEnabled>) {
  return runAction(() => setMcpServerEnabled(...args));
}

export async function deleteMcpServerAction(...args: Parameters<typeof deleteMcpServer>) {
  return runAction(() => deleteMcpServer(...args));
}

export async function probeMcpServerAction(...args: Parameters<typeof probeMcpServer>) {
  return runAction(() => probeMcpServer(...args));
}

export async function refreshMcpServerAction(...args: Parameters<typeof refreshMcpServer>) {
  return runAction(() => refreshMcpServer(...args));
}

export async function startMcpOAuthAction(...args: Parameters<typeof startMcpOAuth>) {
  return runAction(() => startMcpOAuth(...args));
}

export async function disconnectMcpOAuthAction(...args: Parameters<typeof disconnectMcpOAuth>) {
  return runAction(() => disconnectMcpOAuth(...args));
}

export async function loadMcpTargetsAction(...args: Parameters<typeof loadMcpTargets>) {
  return runAction(() => loadMcpTargets(...args));
}

export async function saveMcpAssignmentsAction(...args: Parameters<typeof saveMcpAssignments>) {
  return runAction(() => saveMcpAssignments(...args));
}

export async function setBuilderModelAction(model: string) {
  return runAction(() => setBuilderModel(model));
}

export async function createHostedMcpServerAction(input: unknown) {
  return runAction(() => createHostedMcpServer(input));
}

export async function ensureMcpRolesAction(id: string) {
  return runAction(async () => {
    const saved = await ensureMcpRoles(id);
    return presentMcpServer(saved.serverId);
  });
}

export async function saveMcpPermissionsAction(input: unknown) {
  return runAction(async () => {
    const saved = await saveMcpPermissions(input);
    return presentMcpServer(saved.serverId);
  });
}

export async function setMcpTemplateAction(input: unknown) {
  return runAction(async () => {
    const saved = await setMcpTemplate(input);
    return presentMcpServer(saved.serverId);
  });
}

export async function saveMcpInstallationAction(input: unknown) {
  return runAction(async () => {
    const saved = await saveMcpInstallation(input);
    return presentMcpServer(saved.serverId);
  });
}
