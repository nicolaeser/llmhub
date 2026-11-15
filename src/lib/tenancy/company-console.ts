import "server-only";
import { companySlice } from "@/lib/tenancy/company-view";
import {
  deleteNode,
  pauseNode,
  resumeNode,
  saveCompanyLabelKeys,
  saveMember,
  saveOrg,
  saveProject,
  saveTeam,
} from "@/lib/tenancy/structure";
import type { PauseInput, StructurePayload, TenancyKind } from "@/types/structure";

function companyView(payload: StructurePayload, orgId: string): StructurePayload {
  const view = companySlice(payload, orgId);
  if (!view) throw new Error("NOT_FOUND");
  return view;
}

export async function editCompany(input: { id: string; alias: string }) {
  return companyView(await saveOrg(input), input.id);
}

export async function editCompanyLabels(input: { orgId: string; keys: string[] }) {
  return companyView(await saveCompanyLabelKeys(input), input.orgId);
}

export async function saveCompanyTeam(input: Parameters<typeof saveTeam>[0]) {
  return companyView(await saveTeam(input), input.orgId);
}

export async function saveCompanyProject(input: Parameters<typeof saveProject>[0]) {
  return companyView(await saveProject(input), input.orgId);
}

export async function saveCompanyMember(input: Parameters<typeof saveMember>[0]) {
  return companyView(await saveMember(input), input.orgId);
}

export async function deleteCompanyNode(input: { kind: Exclude<TenancyKind, "org">; id: string; orgId: string }) {
  return companyView(await deleteNode(input), input.orgId);
}

export async function pauseCompanyNode(input: PauseInput & { orgId: string }) {
  return companyView(await pauseNode(input), input.orgId);
}

export async function resumeCompanyNode(input: { kind: TenancyKind; id: string; orgId: string }) {
  return companyView(await resumeNode(input), input.orgId);
}

export async function deleteCompany(id: string) {
  await deleteNode({ kind: "org", id });
  return { id };
}
