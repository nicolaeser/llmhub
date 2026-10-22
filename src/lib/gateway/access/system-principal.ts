import "server-only";
import { withTrace } from "@/lib/gateway/access/gate";
import { SYSTEM_ACTOR_PREFIX, systemEndpoint } from "@/lib/gateway/access/system-callers";
import type { Principal, SystemFeature } from "@/types/gateway";

export function systemPrincipal(feature: SystemFeature): Principal {
  const traced = withTrace(
    {
      actor: `${SYSTEM_ACTOR_PREFIX}${feature}`,
      teamId: "",
      orgId: "",
      userId: "",
      memberId: "",
      models: [],
      routeLimits: {},
    },
    systemEndpoint(feature),
  );
  return { ...traced, pool: "internal", system: feature };
}
