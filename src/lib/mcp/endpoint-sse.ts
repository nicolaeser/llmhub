import "server-only";
import { randomUUID } from "node:crypto";
import { GateError } from "@/lib/gateway/errors";
import {
  answerLegacyBatch,
  INVALID_REQUEST,
  McpEndpointError,
  readMcpMessage,
  rpcFailure,
  type McpEndpointTools,
} from "@/lib/mcp/endpoint";
import { holdLiveStream } from "@/lib/updates/live";
import type { JsonMap, Principal } from "@/types/gateway";

export const MCP_SSE_MESSAGES_PATH = "/api/v1/mcp/messages";
export const MCP_SSE_HEARTBEAT_MS = 15_000;
export const MCP_SSE_SESSIONS_PER_CALLER = 16;
export const MCP_SSE_SESSIONS_TOTAL = 1_000;

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

type SseSession = {
  owner: string;
  send(message: JsonMap): boolean;
};

const holder = globalThis as typeof globalThis & { __llmhubMcpSse?: Map<string, SseSession> };

function sessions(): Map<string, SseSession> {
  holder.__llmhubMcpSse ??= new Map();
  return holder.__llmhubMcpSse;
}

export function mcpSseOwner(principal: Principal): string {
  return principal.key ? `key:${principal.key.token_id}` : `actor:${principal.actor}`;
}

function openSessions(owner: string): number {
  let count = 0;
  for (const session of sessions().values()) if (session.owner === owner) count += 1;
  return count;
}

export function openMcpSseStream(owner: string, signal: AbortSignal): Response {
  const registry = sessions();
  if (registry.size >= MCP_SSE_SESSIONS_TOTAL || openSessions(owner) >= MCP_SSE_SESSIONS_PER_CALLER) {
    throw new GateError(429, "concurrency_limit_exceeded", "too many open MCP SSE connections for this key");
  }
  const id = randomUUID();
  const encoder = new TextEncoder();
  let finish = () => undefined as void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (text: string): boolean => {
        if (!open) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          finish();
          return false;
        }
      };
      const heartbeat = setInterval(() => write(": ping\n\n"), MCP_SSE_HEARTBEAT_MS);
      heartbeat.unref?.();
      let release = () => undefined as void;
      finish = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        registry.delete(id);
        release();
        signal.removeEventListener("abort", finish);
        try {
          controller.close();
        } catch {
          return;
        }
      };
      registry.set(id, { owner, send: (message) => write(`event: message\ndata: ${JSON.stringify(message)}\n\n`) });
      write(`event: endpoint\ndata: ${MCP_SSE_MESSAGES_PATH}?sessionId=${id}\n\n`);
      signal.addEventListener("abort", finish, { once: true });
      release = holdLiveStream(finish);
      if (signal.aborted) finish();
    },
    cancel() {
      finish();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function sessionMissing(): Response {
  return Response.json(rpcFailure(null, INVALID_REQUEST, "Unknown or closed MCP SSE session"), { status: 404 });
}

export async function postMcpSseMessage(
  req: Request,
  owner: string,
  tools: McpEndpointTools,
): Promise<Response> {
  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  const session = sessions().get(sessionId);
  if (!session || session.owner !== owner) return sessionMissing();
  let replies: JsonMap[];
  try {
    replies = await answerLegacyBatch(await readMcpMessage(req), tools, req.signal);
  } catch (err) {
    if (!(err instanceof McpEndpointError)) throw err;
    replies = [rpcFailure(null, err.code, err.message)];
  }
  for (const reply of replies) {
    if (!session.send(reply)) return sessionMissing();
  }
  return new Response("Accepted", { status: 202 });
}
