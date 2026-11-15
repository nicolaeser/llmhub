"use server";

import { runAction } from "@/lib/http/action-result";
import { createKey, loadKeyOptions, pauseKey, resumeKey, revokeKey, rotateKey, updateKey } from "@/lib/keys/manage";
import { loadKeyMcpAccess, saveKeyMcpAccess } from "@/lib/mcp/key-access";
import { loadCompanyMcpServers, saveCompanyMcpInstallation } from "@/lib/mcp/servers";
import { deleteReport, saveReport, sendReportNow } from "@/lib/reports/manage";
import { loadCompanyPolicies } from "@/lib/settings/guardrail-policies";
import { addBoost, removeBoost, setBudget } from "@/lib/tenancy/budgets";
import {
  deleteCompany,
  deleteCompanyNode,
  editCompany,
  editCompanyLabels,
  pauseCompanyNode,
  resumeCompanyNode,
  saveCompanyMember,
  saveCompanyProject,
  saveCompanyTeam,
} from "@/lib/tenancy/company-console";
import { createCompany, loadCompany, loadCompanyDirectory, locateNode } from "@/lib/tenancy/structure";

export async function loadCompanyDirectoryAction() {
  return runAction(() => loadCompanyDirectory());
}

export async function loadCompanyAction(...args: Parameters<typeof loadCompany>) {
  return runAction(() => loadCompany(...args));
}

export async function locateNodeAction(...args: Parameters<typeof locateNode>) {
  return runAction(() => locateNode(...args));
}

export async function createCompanyAction(...args: Parameters<typeof createCompany>) {
  return runAction(() => createCompany(...args));
}

export async function saveOrgAction(...args: Parameters<typeof editCompany>) {
  return runAction(() => editCompany(...args));
}

export async function saveCompanyLabelKeysAction(...args: Parameters<typeof editCompanyLabels>) {
  return runAction(() => editCompanyLabels(...args));
}

export async function saveTeamAction(...args: Parameters<typeof saveCompanyTeam>) {
  return runAction(() => saveCompanyTeam(...args));
}

export async function saveProjectAction(...args: Parameters<typeof saveCompanyProject>) {
  return runAction(() => saveCompanyProject(...args));
}

export async function saveMemberAction(...args: Parameters<typeof saveCompanyMember>) {
  return runAction(() => saveCompanyMember(...args));
}

export async function deleteNodeAction(...args: Parameters<typeof deleteCompanyNode>) {
  return runAction(() => deleteCompanyNode(...args));
}

export async function pauseNodeAction(...args: Parameters<typeof pauseCompanyNode>) {
  return runAction(() => pauseCompanyNode(...args));
}

export async function resumeNodeAction(...args: Parameters<typeof resumeCompanyNode>) {
  return runAction(() => resumeCompanyNode(...args));
}

export async function deleteCompanyAction(...args: Parameters<typeof deleteCompany>) {
  return runAction(() => deleteCompany(...args));
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

export async function createKeyAction(...args: Parameters<typeof createKey>) {
  return runAction(() => createKey(...args));
}

export async function updateKeyAction(...args: Parameters<typeof updateKey>) {
  return runAction(() => updateKey(...args));
}

export async function pauseKeyAction(...args: Parameters<typeof pauseKey>) {
  return runAction(() => pauseKey(...args));
}

export async function resumeKeyAction(...args: Parameters<typeof resumeKey>) {
  return runAction(() => resumeKey(...args));
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
