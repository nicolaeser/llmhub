import { gateRequest } from "@/lib/gateway/access/gate";
import { gatewayRoute } from "@/lib/gateway/endpoints/pipeline";
import { handleHubMcp } from "@/lib/mcp/hub";

export const maxDuration = 60;

export const POST = gatewayRoute(async (req) => {
  const principal = await gateRequest(req);
  const body = await req.json().catch(() => null);
  return handleHubMcp(principal, body);
});
