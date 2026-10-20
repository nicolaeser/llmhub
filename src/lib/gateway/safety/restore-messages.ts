import { jsonStringBody, restoreJson, type PiiVault } from "@/lib/gateway/safety/pii-vault";
import { parseSseBlock, plainText, restoreSse, splitPending, sseText, type Encode } from "@/lib/gateway/safety/restore-sse";
import { asRecord } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";

type DeltaField = { field: string; encode: Encode };
type HeldDelta = { type: string; field: DeltaField; text: string };

const RESTORED_DELTAS: Record<string, DeltaField> = {
  text_delta: { field: "text", encode: plainText },
  input_json_delta: { field: "partial_json", encode: jsonStringBody },
};
const CLOSING_EVENTS = new Set(["message_delta", "message_stop", "error"]);

class MessagesRestorer {
  private readonly held = new Map<number, HeldDelta>();

  constructor(private readonly vault: PiiVault) {}

  block(block: string): string {
    const parsed = parseSseBlock(block);
    if (!parsed) return `${block}\n\n`;
    const { event, json } = parsed;
    const type = typeof json.type === "string" ? json.type : event;
    if (type === "content_block_delta") return this.delta(event, json);
    const prefix = type === "content_block_stop" ? this.release(Number(json.index ?? 0)) : CLOSING_EVENTS.has(type) ? this.flush() : "";
    return prefix + sseText(event, restoreJson(json, this.vault) as JsonMap);
  }

  flush(): string {
    return [...this.held.keys()].map((index) => this.release(index)).join("");
  }

  private delta(event: string, json: JsonMap): string {
    const index = Number(json.index ?? 0);
    const delta = asRecord(json.delta);
    const field = delta ? RESTORED_DELTAS[String(delta.type)] : undefined;
    const piece = field ? delta?.[field.field] : undefined;
    if (!delta || !field || typeof piece !== "string") return sseText(event, json);
    const text = (this.held.get(index)?.text ?? "") + piece;
    const { head, tail } = splitPending(text);
    if (tail) this.held.set(index, { type: String(delta.type), field, text: tail });
    else this.held.delete(index);
    if (!head) return "";
    return sseText(event, { ...json, delta: { ...delta, [field.field]: this.vault.restore(head, field.encode) } });
  }

  private release(index: number): string {
    const held = this.held.get(index);
    this.held.delete(index);
    if (!held) return "";
    const delta = { type: held.type, [held.field.field]: this.vault.restore(held.text, held.field.encode) };
    return sseText("content_block_delta", { type: "content_block_delta", index, delta });
  }
}

export function restoreMessagesSse(response: Response, vault: PiiVault | null): Response {
  return vault?.size ? restoreSse(response, new MessagesRestorer(vault)) : response;
}
