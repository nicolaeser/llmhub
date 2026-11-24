import { gateRequest } from "@/lib/gateway/access/gate";
import { gatewayRoute } from "@/lib/gateway/endpoints/pipeline";
import { acceptsEventStream, methodNotAllowed, serveMcpPost } from "@/lib/mcp/endpoint";
import { mcpSseOwner, openMcpSseStream } from "@/lib/mcp/endpoint-sse";
import { hubMcpTools } from "@/lib/mcp/hub";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = gatewayRoute(async (req) => {
  const principal = await gateRequest(req);
  return serveMcpPost(req, hubMcpTools(principal));
});

export const GET = gatewayRoute(async (req) => {
  const principal = await gateRequest(req);
  const streamableClient = req.headers.has("mcp-protocol-version") || req.headers.has("mcp-session-id");
  if (streamableClient || !acceptsEventStream(req)) return methodNotAllowed();
  return openMcpSseStream(mcpSseOwner(principal), req.signal);
});
