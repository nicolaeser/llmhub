import { gateRequest } from "@/lib/gateway/access/gate";
import { gatewayRoute } from "@/lib/gateway/endpoints/pipeline";
import { mcpSseOwner, postMcpSseMessage } from "@/lib/mcp/endpoint-sse";
import { hubMcpTools } from "@/lib/mcp/hub";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = gatewayRoute(async (req) => {
  const principal = await gateRequest(req);
  return postMcpSseMessage(req, mcpSseOwner(principal), hubMcpTools(principal));
});
