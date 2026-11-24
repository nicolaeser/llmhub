import { gateRequest } from "@/lib/gateway/access/gate";
import { gatewayRoute } from "@/lib/gateway/endpoints/pipeline";
import { integrationMcpTools } from "@/lib/integrations/mcp-gateway";
import { serveMcpPost } from "@/lib/mcp/endpoint";

export const maxDuration = 60;

export const POST = gatewayRoute(async (req) => {
  const principal = await gateRequest(req);
  const agent = req.headers.get("x-llmhub-agent")?.trim() ?? "";
  return serveMcpPost(req, integrationMcpTools(principal, agent));
});
