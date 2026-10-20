import { asRecord } from "@/lib/gateway/core";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cancelQuietly } from "@/lib/utils/streams";
import type { JsonMap } from "@/types/gateway";

export type SseRestorer = { block(block: string): string; flush(): string };
export type Encode = (value: string) => string;

const PLACEHOLDER_START = /\[[A-Z0-9_]{0,80}$/;
const DONE_BLOCK = /^data: ?\[DONE\]$/;

export const plainText: Encode = (value) => value;

export function splitPending(text: string): { head: string; tail: string } {
  const tail = text.match(PLACEHOLDER_START)?.[0] ?? "";
  return { head: text.slice(0, text.length - tail.length), tail };
}

export function isDoneBlock(block: string): boolean {
  return DONE_BLOCK.test(block.trim());
}

export function sseText(event: string, json: JsonMap): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(json)}\n\n`;
}

export function sseKeep(block: string, event: string, original: JsonMap, next: JsonMap): string {
  const data = JSON.stringify(next);
  if (data === JSON.stringify(original)) return `${block}\n\n`;
  return `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`;
}

export function parseSseBlock(block: string): { event: string; json: JsonMap } | null {
  let event = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line) return null;
  }
  const json = asRecord(parseJsonOrNull(data.join("\n")));
  return json ? { event, json } : null;
}

export function restoreSse(response: Response, restorer: SseRestorer): Response {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = response.body.getReader();
  let buffer = "";
  const drain = (final: boolean): string => {
    const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
    buffer = final ? "" : (blocks.pop() ?? "");
    const out = blocks.filter((block) => block.trim()).map((block) => restorer.block(block)).join("");
    return final ? out + restorer.flush() : out;
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const rest = drain(true);
          if (rest) controller.enqueue(encoder.encode(rest));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const out = drain(false);
        if (!out) continue;
        controller.enqueue(encoder.encode(out));
        return;
      }
    },
    cancel() {
      void cancelQuietly(reader);
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
