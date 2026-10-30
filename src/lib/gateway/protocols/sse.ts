import { after } from "next/server";
import { holdShutdown } from "@/lib/http/drain";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cancelQuietly } from "@/lib/utils/streams";
import type { JsonMap } from "@/types/gateway";
import type { SseRelayOptions } from "@/types/responses";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export const KEEPALIVE_MS = 15_000;

export const SSE_KEEPALIVE = ": keep-alive\n\n";

function serialize(event: string, data: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`;
}

export function sseEvent(type: string, payload: JsonMap): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function sseData(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
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
  const parsed = parseJsonOrNull(payload);
  const json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonMap) : null;
  if (!json) return serialize(event, payload);
  const type = event || (typeof json.type === "string" ? json.type : "");
  const mapped = options.map ? options.map(json, type) : json;
  if (mapped === null) return null;
  return serialize(event, JSON.stringify(mapped));
}

function keepServerFor(task: Promise<void>): boolean {
  holdShutdown(task);
  try {
    after(task);
    return true;
  } catch {
    return false;
  }
}

export function relaySse(source: Response, options: SseRelayOptions): Response {
  const reader = source.body?.getReader() ?? null;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let ended = false;
  let finished = () => {};
  keepServerFor(new Promise<void>((resolve) => (finished = resolve)));

  const end = async (failure: unknown = null, cancelled = false) => {
    if (ended) return;
    ended = true;
    try {
      await options.onEnd?.(failure, cancelled);
    } catch (err) {
      logger.error("gateway.stream_finish_failed", errorFields(err));
    } finally {
      finished();
    }
  };

  const finalize = async (controller: ReadableStreamDefaultController<Uint8Array>, failure: unknown) => {
    const tail = options.tail?.(failure) ?? null;
    if (tail) controller.enqueue(encoder.encode(tail));
    controller.close();
    await end(failure);
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
        controller.close();
        await end();
        return;
      }
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            for (const event of drain(true)) controller.enqueue(encoder.encode(event));
            await finalize(controller, null);
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const events = drain(false);
          if (!events.length) continue;
          for (const event of events) controller.enqueue(encoder.encode(event));
          return;
        }
      } catch (err) {
        if (options.tail) {
          await finalize(controller, err);
          return;
        }
        await end(err);
        controller.error(err);
      }
    },
    cancel() {
      void cancelQuietly(reader);
      void end(null, true);
    },
  });

  return new Response(stream, { status: source.status, headers: SSE_HEADERS });
}
