import { jsonStringBody, restoreJson, type PiiVault } from "@/lib/gateway/safety/pii-vault";
import {
  parseSseBlock,
  plainText,
  restoreSse,
  splitPending,
  sseKeep,
  sseText,
  type Encode,
  type SseRestorer,
} from "@/lib/gateway/safety/restore-sse";
import type { JsonMap } from "@/types/gateway";

type HeldDelta = { event: string; template: JsonMap; text: string; encode: Encode };

const RESTORED_DELTAS: Record<string, Encode> = {
  "response.output_text.delta": plainText,
  "response.refusal.delta": plainText,
  "response.reasoning_summary_text.delta": plainText,
  "response.reasoning_text.delta": plainText,
  "response.custom_tool_call_input.delta": plainText,
  "response.function_call_arguments.delta": jsonStringBody,
  "response.mcp_call_arguments.delta": jsonStringBody,
};
const CLOSING_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);
const DONE_SUFFIX = /\.done$/;

function streamKey(deltaType: string, json: JsonMap): string {
  return [deltaType, json.item_id, json.output_index, json.content_index, json.summary_index].map((part) => String(part ?? "")).join("\0");
}

class ResponsesRestorer implements SseRestorer {
  private readonly held = new Map<string, HeldDelta>();
  private sequence: number | undefined;

  constructor(private readonly vault: PiiVault) {}

  block(block: string): string {
    const parsed = parseSseBlock(block);
    if (!parsed) return `${block}\n\n`;
    const { event, json } = parsed;
    const type = typeof json.type === "string" ? json.type : event;
    const encode = RESTORED_DELTAS[type];
    if (encode && typeof json.delta === "string") return this.delta(block, event, type, json, encode);
    return this.released(type, json) + sseKeep(block, event, json, this.numbered(restoreJson(json, this.vault) as JsonMap));
  }

  flush(): string {
    return [...this.held.keys()].map((key) => this.release(key)).join("");
  }

  private released(type: string, json: JsonMap): string {
    const deltaType = type.replace(DONE_SUFFIX, ".delta");
    if (deltaType !== type && RESTORED_DELTAS[deltaType]) return this.release(streamKey(deltaType, json));
    if (type === "response.output_item.done") {
      const keys = [...this.held].filter(([, held]) => held.template.output_index === json.output_index).map(([key]) => key);
      return keys.map((key) => this.release(key)).join("");
    }
    return CLOSING_EVENTS.has(type) ? this.flush() : "";
  }

  private delta(block: string, event: string, type: string, json: JsonMap, encode: Encode): string {
    const key = streamKey(type, json);
    const text = (this.held.get(key)?.text ?? "") + String(json.delta);
    const { head, tail } = splitPending(text);
    if (tail) this.held.set(key, { event, template: json, text: tail, encode });
    else this.held.delete(key);
    if (!head) return "";
    const restored = restoreJson(json, this.vault) as JsonMap;
    return sseKeep(block, event, json, this.numbered({ ...restored, delta: this.vault.restore(head, encode) }));
  }

  private release(key: string): string {
    const held = this.held.get(key);
    this.held.delete(key);
    if (!held) return "";
    const restored = restoreJson(held.template, this.vault) as JsonMap;
    return sseText(held.event, this.numbered({ ...restored, delta: this.vault.restore(held.text, held.encode) }));
  }

  private numbered(json: JsonMap): JsonMap {
    if (typeof json.sequence_number !== "number") return json;
    this.sequence = this.sequence === undefined ? json.sequence_number : this.sequence + 1;
    return { ...json, sequence_number: this.sequence };
  }
}

export function restoreResponsesSse(response: Response, vault: PiiVault | null): Response {
  return vault?.size ? restoreSse(response, new ResponsesRestorer(vault)) : response;
}
