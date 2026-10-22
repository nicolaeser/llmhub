import type { SystemFeature } from "@/types/gateway";
import type { RequestLogRow } from "@/types/logs";

export const SYSTEM_ACTOR_PREFIX = "system:";
export const SYSTEM_ENDPOINT_PREFIX = "internal:";
export const SYSTEM_FEATURES = ["catalog", "mcp_builder", "model_test", "pii"] as const satisfies readonly SystemFeature[];

export function systemEndpoint(feature: SystemFeature): string {
  return `${SYSTEM_ENDPOINT_PREFIX}${feature}`;
}

export function systemFeatureOf(
  row: Pick<RequestLogRow, "endpoint" | "keyId" | "userId" | "memberId" | "projectId" | "teamId" | "orgId">,
): SystemFeature | "" {
  if (row.keyId || row.userId || row.memberId || row.projectId || row.teamId || row.orgId) return "";
  if (!row.endpoint.startsWith(SYSTEM_ENDPOINT_PREFIX)) return "";
  const feature = row.endpoint.slice(SYSTEM_ENDPOINT_PREFIX.length);
  return SYSTEM_FEATURES.find((known) => known === feature) ?? "";
}
