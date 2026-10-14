import { gatewayRoute } from "@/lib/gateway/endpoints/pipeline";
import { gateRequest } from "@/lib/gateway/access/gate";
import { handleIntegrationMcp } from "@/lib/integrations/mcp-gateway";

export const maxDuration = 60;

export const POST = gatewayRoute(async (req) => {
  const principal = await gateRequest(req);
  const body = await req.json().catch(() => null);
  const agent = req.headers.get("x-llmhub-agent")?.trim() ?? "";
  const result = await handleIntegrationMcp(principal, body, agent);
  return Response.json(result);
});
