import { restoreJson, type PiiVault } from "@/lib/gateway/safety/pii-vault";
import { asRecord } from "@/lib/gateway/core";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cancelQuietly } from "@/lib/utils/streams";
import type { JsonMap } from "@/types/gateway";

type DeltaField = { field: string; encode: (value: string) => string };
type HeldDelta = { type: string; field: DeltaField; text: string };

const PLACEHOLDER_START = /\[[A-Z0-9_]{0,80}$/;
const jsonStringBody = (value: string): string => JSON.stringify(value).slice(1, -1);
const RESTORED_DELTAS: Record<string, DeltaField> = {
  text_delta: { field: "text", encode: (value) => value },
  input_json_delta: { field: "partial_json", encode: jsonStringBody },
};
const CLOSING_EVENTS = new Set(["message_delta", "message_stop", "error"]);

function eventText(event: string, json: JsonMap): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(json)}\n\n`;
}

function parseBlock(block: string): { event: string; json: JsonMap } | null {
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

class MessagesRestorer {
  private readonly held = new Map<number, HeldDelta>();

  constructor(private readonly vault: PiiVault) {}

  block(block: string): string {
    const parsed = parseBlock(block);
    if (!parsed) return `${block}\n\n`;
    const { event, json } = parsed;
    const type = typeof json.type === "string" ? json.type : event;
    if (type === "content_block_delta") return this.delta(event, json);
    const prefix = type === "content_block_stop" ? this.release(Number(json.index ?? 0)) : CLOSING_EVENTS.has(type) ? this.flush() : "";
    return prefix + eventText(event, restoreJson(json, this.vault) as JsonMap);
  }

  flush(): string {
    return [...this.held.keys()].map((index) => this.release(index)).join("");
  }

  private delta(event: string, json: JsonMap): string {
    const index = Number(json.index ?? 0);
    const delta = asRecord(json.delta);
    const field = delta ? RESTORED_DELTAS[String(delta.type)] : undefined;
    const piece = field ? delta?.[field.field] : undefined;
    if (!delta || !field || typeof piece !== "string") return eventText(event, json);
    const text = (this.held.get(index)?.text ?? "") + piece;
    const tail = text.match(PLACEHOLDER_START)?.[0] ?? "";
    const head = text.slice(0, text.length - tail.length);
    if (tail) this.held.set(index, { type: String(delta.type), field, text: tail });
    else this.held.delete(index);
    if (!head) return "";
    return eventText(event, { ...json, delta: { ...delta, [field.field]: this.vault.restore(head, field.encode) } });
  }

  private release(index: number): string {
    const held = this.held.get(index);
    this.held.delete(index);
    if (!held) return "";
    const delta = { type: held.type, [held.field.field]: this.vault.restore(held.text, held.field.encode) };
    return eventText("content_block_delta", { type: "content_block_delta", index, delta });
  }
}

export function restoreMessagesSse(response: Response, vault: PiiVault | null): Response {
  if (!vault?.size || !response.body) return response;
  const restorer = new MessagesRestorer(vault);
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
