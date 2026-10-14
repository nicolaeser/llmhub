import type {
  IntegrationStatus,
  IntegrationVisibility,
  PolicyRule,
  PolicyScopeName,
} from "@/types/integrations";
import { publishBlocked } from "@/lib/integrations/lifecycle";

export function canInstantiate(
  visibility: IntegrationVisibility,
  audience: readonly string[],
  orgId: string,
): boolean {
  if (visibility === "all") return true;
  if (visibility === "selected") return audience.includes(orgId);
  return false;
}

export function blueprintListed(
  visibility: IntegrationVisibility,
  audience: readonly string[],
  viewerOrgId: string | null,
): boolean {
  if (!viewerOrgId) return true;
  return canInstantiate(visibility, audience, viewerOrgId);
}

export function sameCompany(actorOrgId: string | null, resourceOrgId: string): boolean {
  return !actorOrgId || actorOrgId === resourceOrgId;
}

export type PublicationChecks = {
  configuration: boolean;
  schema: boolean;
  permission: boolean;
};

export function publicationBlock(input: {
  status: IntegrationStatus;
  approvalRequired: boolean;
  approved: boolean;
  checks: PublicationChecks;
  actor: "user" | "agent";
}): string {
  if (input.actor === "agent") return "approval_required";
  if (!input.checks.configuration || !input.checks.schema || !input.checks.permission) return "not_validated";
  return publishBlocked(input.status, input.approvalRequired, input.approved);
}

export function mergePolicyLayers(
  layers: readonly { scope: PolicyScopeName; version: number; rules: readonly PolicyRule[] }[],
): { rules: PolicyRule[]; version: number } {
  const rules = layers.flatMap((layer) => [...layer.rules]);
  const version = layers.reduce((max, layer) => Math.max(max, layer.version), 0);
  return { rules, version };
}

export function publicCredential(row: {
  sealedSecret: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  label: string;
}): { hasSecret: boolean; revoked: boolean; expiresAt: string; label: string } {
  return {
    hasSecret: Boolean(row.sealedSecret) && !row.revokedAt,
    revoked: Boolean(row.revokedAt),
    expiresAt: row.expiresAt?.toISOString() ?? "",
    label: row.label,
  };
}
