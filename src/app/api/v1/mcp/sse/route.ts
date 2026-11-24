import { gateRequest } from "@/lib/gateway/access/gate";
import { gatewayRoute } from "@/lib/gateway/endpoints/pipeline";
import { acceptsEventStream, methodNotAllowed } from "@/lib/mcp/endpoint";
import { mcpSseOwner, openMcpSseStream } from "@/lib/mcp/endpoint-sse";

export const dynamic = "force-dynamic";

export const GET = gatewayRoute(async (req) => {
  const principal = await gateRequest(req);
  if (!acceptsEventStream(req)) return methodNotAllowed();
  return openMcpSseStream(mcpSseOwner(principal), req.signal);
});
