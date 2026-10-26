import "server-only";
import prisma from "@/lib/db/prisma";
import { bodyLabels, mergeLabels, pickLabels } from "@/lib/gateway/billing/request-labels";
import { defaultEntityIds, redactPii } from "@/lib/gateway/safety/pii";
import { requestEnterprise, resolvePii } from "@/lib/settings/enterprise";
import { labelValue } from "@/lib/usage/labels";
import { SizedLru } from "@/lib/utils/sized-lru";
import type { Principal } from "@/types/gateway";
import type { RequestLabel } from "@/types/usage";

export const COMPANY_LABEL_KEYS_TTL_MS = 30_000;
const COMPANY_LABEL_KEYS_CAPACITY = 10_000;

const companyKeys = new SizedLru<{ at: number; keys: Promise<readonly string[]> }>(COMPANY_LABEL_KEYS_CAPACITY);

async function loadCompanyLabelKeys(orgId: string): Promise<readonly string[]> {
  const row = await prisma.organization.findUnique({ where: { id: orgId }, select: { labelKeys: true } });
  return row?.labelKeys ?? [];
}

export function companyLabelKeys(orgId: string, now = Date.now()): Promise<readonly string[]> {
  const cached = companyKeys.get(orgId);
  if (cached && now - cached.at < COMPANY_LABEL_KEYS_TTL_MS) return cached.keys;
  const entry = { at: now, keys: loadCompanyLabelKeys(orgId) };
  companyKeys.set(orgId, entry, 1);
  entry.keys.catch(() => {
    if (companyKeys.get(orgId) === entry) companyKeys.delete(orgId);
  });
  return entry.keys;
}

export function forgetCompanyLabelKeys(orgId: string): void {
  companyKeys.delete(orgId);
}

export async function allowedLabelKeys(principal: Principal): Promise<Set<string>> {
  const [enterprise, company] = await Promise.all([
    requestEnterprise(principal),
    principal.orgId ? companyLabelKeys(principal.orgId) : [],
  ]);
  return new Set([...(enterprise.label_keys ?? []), ...company]);
}

export async function requestLabels(principal: Principal, request: unknown): Promise<RequestLabel[]> {
  if (principal.system) return [];
  const candidates = mergeLabels(principal.trace?.labels, bodyLabels(request));
  if (!Object.keys(candidates).length) return [];
  const allowed = await allowedLabelKeys(principal);
  const picked = pickLabels(candidates, allowed);
  if (!picked.length) return picked;
  const pii = await resolvePii(principal);
  if (!pii.enabled) return picked;
  const entities = pii.entities.length ? pii.entities : defaultEntityIds();
  return picked.flatMap((label) => {
    const value = labelValue(redactPii(label.value, entities));
    return value ? [{ key: label.key, value }] : [];
  });
}
