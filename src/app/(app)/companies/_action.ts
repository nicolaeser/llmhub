"use server";

import { runAction } from "@/lib/http/action-result";
import {
  createKey,
  loadKeyOptions,
  pauseKey,
  resumeKey,
  revokeKey,
  rotateKey,
  updateKey,
} from "@/lib/keys/manage";
import { loadKeyMcpAccess, saveKeyMcpAccess } from "@/lib/mcp/key-access";
import { loadCompanyMcpServers, saveCompanyMcpInstallation } from "@/lib/mcp/servers";
import { loadCompanyPolicies } from "@/lib/settings/guardrail-policies";
import { addBoost, removeBoost, setBudget } from "@/lib/tenancy/budgets";
import { companySlice } from "@/lib/tenancy/company-view";
import {
  createCompany,
  deleteNode,
  loadCompany,
  loadCompanyDirectory,
  locateNode,
  saveCompanyLabelKeys,
  saveMember,
  saveOrg,
  saveProject,
  saveTeam,
} from "@/lib/tenancy/structure";
import { deleteReport, saveReport, sendReportNow } from "@/lib/reports/manage";
import type { StructurePayload, TenancyKind } from "@/types/structure";

function companyView(payload: StructurePayload, orgId: string): StructurePayload {
  const view = companySlice(payload, orgId);
  if (!view) throw new Error("NOT_FOUND");
  return view;
}

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

export async function saveOrgAction(input: { id: string; alias: string }) {
  return runAction(async () => companyView(await saveOrg(input), input.id));
}

export async function saveCompanyLabelKeysAction(input: { orgId: string; keys: string[] }) {
  return runAction(async () => companyView(await saveCompanyLabelKeys(input), input.orgId));
}

export async function saveTeamAction(input: Parameters<typeof saveTeam>[0]) {
  return runAction(async () => companyView(await saveTeam(input), input.orgId));
}

export async function saveProjectAction(input: Parameters<typeof saveProject>[0]) {
  return runAction(async () => companyView(await saveProject(input), input.orgId));
}

export async function saveMemberAction(input: Parameters<typeof saveMember>[0]) {
  return runAction(async () => companyView(await saveMember(input), input.orgId));
}

export async function deleteNodeAction(input: { kind: Exclude<TenancyKind, "org">; id: string; orgId: string }) {
  return runAction(async () => companyView(await deleteNode(input), input.orgId));
}

export async function deleteCompanyAction(id: string) {
  return runAction(async () => {
    await deleteNode({ kind: "org", id });
    return { id };
  });
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
