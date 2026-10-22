import "server-only";
import { withTrace } from "@/lib/gateway/access/gate";
import type { Principal } from "@/types/gateway";

export const SYSTEM_ACTOR_PREFIX = "system:";
export const SYSTEM_ENDPOINT_PREFIX = "internal:";

export function systemPrincipal(feature: string): Principal {
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
    `${SYSTEM_ENDPOINT_PREFIX}${feature}`,
  );
  return { ...traced, pool: "internal", system: true };
}
