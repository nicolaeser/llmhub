import type { JsonMap } from "@/types/gateway";
import type { SseRelayOptions } from "@/types/responses";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

function serialize(event: string, data: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`;
}

export function relayEvent(block: string, options: SseRelayOptions): string | null {
  let event = "";
  const data: string[] = [];
  let other = false;
  for (const raw of block.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else other = true;
  }
  if (!data.length) return other || event ? `${block}\n\n` : null;
  const payload = data.join("\n");
  let json: JsonMap | null = null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonMap) : null;
  } catch {}
  if (!json) return serialize(event, payload);
  const type = event || (typeof json.type === "string" ? json.type : "");
  const mapped = options.map ? options.map(json, type) : json;
  if (mapped === null) return null;
  return serialize(event, JSON.stringify(mapped));
}

export function relaySse(source: Response, options: SseRelayOptions): Response {
  const reader = source.body?.getReader() ?? null;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let ended = false;

  const end = async () => {
    if (ended) return;
    ended = true;
    try {
      await options.onEnd?.();
    } catch {}
  };

  const drain = (final: boolean): string[] => {
    const normalized = buffer.replace(/\r\n/g, "\n");
    const blocks = normalized.split("\n\n");
    buffer = final ? "" : (blocks.pop() ?? "");
    const out: string[] = [];
    for (const block of blocks) {
      if (!block.trim()) continue;
      const relayed = relayEvent(block, options);
      if (relayed) out.push(relayed);
    }
    return out;
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!reader) {
        await end();
        controller.close();
        return;
      }
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            for (const event of drain(true)) controller.enqueue(encoder.encode(event));
            await end();
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const events = drain(false);
          if (!events.length) continue;
          for (const event of events) controller.enqueue(encoder.encode(event));
          return;
        }
      } catch (err) {
        await end();
        controller.error(err);
      }
    },
    cancel() {
      void reader?.cancel().catch(() => undefined);
      void end();
    },
  });

  return new Response(stream, { status: source.status, headers: SSE_HEADERS });
}
