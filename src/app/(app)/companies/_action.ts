"use server";

import { runAction } from "@/lib/http/action-result";
import { createKey, loadKeyDetail, loadKeyOptions, revokeKey, rotateKey, updateKey } from "@/lib/keys/manage";
import { loadKeyMcpAccess, saveKeyMcpAccess } from "@/lib/mcp/key-access";
import { loadCompanyMcpServers, saveCompanyMcpInstallation } from "@/lib/mcp/servers";
import { loadCompanyPolicies } from "@/lib/settings/guardrail-policies";
import { addBoost, removeBoost, setBudget } from "@/lib/tenancy/budgets";
import {
  deleteNode,
  loadStructure,
  saveMember,
  saveOrg,
  saveProject,
  saveTeam,
} from "@/lib/tenancy/structure";
import { deleteReport, saveReport, sendReportNow } from "@/lib/reports/manage";

export async function loadStructureAction(...args: Parameters<typeof loadStructure>) {
  return runAction(() => loadStructure(...args));
}

export async function saveOrgAction(...args: Parameters<typeof saveOrg>) {
  return runAction(() => saveOrg(...args));
}

export async function saveTeamAction(...args: Parameters<typeof saveTeam>) {
  return runAction(() => saveTeam(...args));
}

export async function saveProjectAction(...args: Parameters<typeof saveProject>) {
  return runAction(() => saveProject(...args));
}

export async function saveMemberAction(...args: Parameters<typeof saveMember>) {
  return runAction(() => saveMember(...args));
}

export async function deleteNodeAction(...args: Parameters<typeof deleteNode>) {
  return runAction(() => deleteNode(...args));
}

export async function setBudgetAction(...args: Parameters<typeof setBudget>) {
  return runAction(() => setBudget(...args));
}

export async function addBoostAction(...args: Parameters<typeof addBoost>) {
  return runAction(() => addBoost(...args));
}

export async function removeBoostAction(...args: Parameters<typeof removeBoost>) {
  return runAction(() => removeBoost(...args));
}

export async function saveReportAction(...args: Parameters<typeof saveReport>) {
  return runAction(() => saveReport(...args));
}

export async function deleteReportAction(...args: Parameters<typeof deleteReport>) {
  return runAction(() => deleteReport(...args));
}

export async function sendReportNowAction(...args: Parameters<typeof sendReportNow>) {
  return runAction(() => sendReportNow(...args));
}

export async function loadCompanyMcpAction(...args: Parameters<typeof loadCompanyMcpServers>) {
  return runAction(() => loadCompanyMcpServers(...args));
}

export async function saveCompanyMcpInstallationAction(...args: Parameters<typeof saveCompanyMcpInstallation>) {
  return runAction(() => saveCompanyMcpInstallation(...args));
}

export async function loadCompanyPoliciesAction(...args: Parameters<typeof loadCompanyPolicies>) {
  return runAction(() => loadCompanyPolicies(...args));
}

export async function loadKeyOptionsAction() {
  return runAction(() => loadKeyOptions());
}

export async function loadKeyDetailAction(...args: Parameters<typeof loadKeyDetail>) {
  return runAction(() => loadKeyDetail(...args));
}

export async function createKeyAction(...args: Parameters<typeof createKey>) {
  return runAction(() => createKey(...args));
}

export async function updateKeyAction(...args: Parameters<typeof updateKey>) {
  return runAction(() => updateKey(...args));
}

export async function rotateKeyAction(...args: Parameters<typeof rotateKey>) {
  return runAction(() => rotateKey(...args));
}

export async function revokeKeyAction(...args: Parameters<typeof revokeKey>) {
  return runAction(() => revokeKey(...args));
}

export async function loadKeyMcpAccessAction(...args: Parameters<typeof loadKeyMcpAccess>) {
  return runAction(() => loadKeyMcpAccess(...args));
}

export async function saveKeyMcpAccessAction(...args: Parameters<typeof saveKeyMcpAccess>) {
  return runAction(() => saveKeyMcpAccess(...args));
}
