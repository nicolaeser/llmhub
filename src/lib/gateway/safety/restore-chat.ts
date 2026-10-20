import { jsonStringBody, restoreJson, type PiiVault } from "@/lib/gateway/safety/pii-vault";
import {
  isDoneBlock,
  parseSseBlock,
  plainText,
  restoreSse,
  splitPending,
  sseKeep,
  sseText,
  type Encode,
  type SseRestorer,
} from "@/lib/gateway/safety/restore-sse";
import { asRecord } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";

const DELTA_TEXT_FIELDS = new Set(["content", "refusal", "reasoning_content", "reasoning"]);
const LEGACY_TEXT_FIELD = "text";
const ENVELOPE_SKIPPED = new Set(["choices", "usage", "error"]);
const TOOL_PREFIX = "tool:";

const toolField = (call: JsonMap): string => `${TOOL_PREFIX}${Number(call.index ?? 0)}`;

function mapEntries(record: JsonMap, map: (key: string, value: unknown) => unknown): JsonMap {
  const out: JsonMap = {};
  for (const [key, value] of Object.entries(record)) out[key] = map(key, value);
  return out;
}

function streamedFields(choice: JsonMap): Set<string> {
  const fields = new Set<string>();
  if (typeof choice[LEGACY_TEXT_FIELD] === "string") fields.add(LEGACY_TEXT_FIELD);
  const delta = asRecord(choice.delta) ?? {};
  for (const field of DELTA_TEXT_FIELDS) if (typeof delta[field] === "string") fields.add(field);
  for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const call = asRecord(raw);
    if (call && typeof asRecord(call.function)?.arguments === "string") fields.add(toolField(call));
  }
  return fields;
}

class ChatRestorer implements SseRestorer {
  private readonly held = new Map<number, Map<string, string>>();
  private envelope: JsonMap = {};

  constructor(private readonly vault: PiiVault) {}

  block(block: string): string {
    const parsed = parseSseBlock(block);
    if (!parsed) return `${isDoneBlock(block) ? this.flush() : ""}${block}\n\n`;
    const { event, json } = parsed;
    if (!Array.isArray(json.choices)) return this.flush() + sseKeep(block, event, json, restoreJson(json, this.vault) as JsonMap);
    this.envelope = Object.fromEntries(Object.entries(json).filter(([key]) => !ENVELOPE_SKIPPED.has(key)));
    let released = "";
    const choices = json.choices.map((raw) => {
      const choice = asRecord(raw);
      if (!choice) return raw;
      const index = Number(choice.index ?? 0);
      const finishing = choice.finish_reason !== null && choice.finish_reason !== undefined;
      if (finishing) released += this.release(index, streamedFields(choice));
      return this.choice(index, choice, finishing);
    });
    const next = mapEntries(json, (key, value) => (key === "choices" ? choices : restoreJson(value, this.vault, key)));
    return released + sseKeep(block, event, json, next);
  }

  flush(): string {
    return [...this.held.keys()].map((index) => this.release(index)).join("");
  }

  private choice(index: number, choice: JsonMap, finishing: boolean): JsonMap {
    return mapEntries(choice, (key, value) => {
      if (key === LEGACY_TEXT_FIELD && typeof value === "string") return this.take(index, key, value, finishing, plainText);
      if (key === "delta" && asRecord(value)) return this.delta(index, value as JsonMap, finishing);
      return restoreJson(value, this.vault, key);
    });
  }

  private delta(index: number, delta: JsonMap, finishing: boolean): JsonMap {
    return mapEntries(delta, (key, value) => {
      if (DELTA_TEXT_FIELDS.has(key) && typeof value === "string") return this.take(index, key, value, finishing, plainText);
      if (key === "tool_calls" && Array.isArray(value)) return value.map((call) => this.toolCall(index, call, finishing));
      return restoreJson(value, this.vault, key);
    });
  }

  private toolCall(index: number, raw: unknown, finishing: boolean): unknown {
    const call = asRecord(raw);
    if (!call) return raw;
    const slot = toolField(call);
    return mapEntries(call, (key, value) => {
      const fn = asRecord(value);
      if (key !== "function" || !fn) return restoreJson(value, this.vault, key);
      return mapEntries(fn, (name, item) =>
        name === "arguments" && typeof item === "string"
          ? this.take(index, slot, item, finishing, jsonStringBody)
          : restoreJson(item, this.vault, name),
      );
    });
  }

  private take(index: number, field: string, piece: string, finishing: boolean, encode: Encode): string {
    const slot = this.held.get(index) ?? new Map<string, string>();
    const text = (slot.get(field) ?? "") + piece;
    const { head, tail } = finishing ? { head: text, tail: "" } : splitPending(text);
    if (tail) slot.set(field, tail);
    else slot.delete(field);
    if (slot.size) this.held.set(index, slot);
    else this.held.delete(index);
    return this.vault.restore(head, encode);
  }

  private release(index: number, kept: Set<string> = new Set()): string {
    const slot = this.held.get(index);
    if (!slot) return "";
    const fields: JsonMap = {};
    const tools: JsonMap[] = [];
    for (const [field, text] of slot) {
      if (kept.has(field)) continue;
      slot.delete(field);
      if (!field.startsWith(TOOL_PREFIX)) fields[field] = this.vault.restore(text);
      else tools.push({ index: Number(field.slice(TOOL_PREFIX.length)), function: { arguments: this.vault.restore(text, jsonStringBody) } });
    }
    if (!slot.size) this.held.delete(index);
    if (!Object.keys(fields).length && !tools.length) return "";
    const choice =
      LEGACY_TEXT_FIELD in fields
        ? { index, text: fields[LEGACY_TEXT_FIELD], logprobs: null, finish_reason: null }
        : { index, delta: { ...fields, ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: null };
    return sseText("", { ...this.envelope, choices: [choice] });
  }
}

export function restoreChatSse(response: Response, vault: PiiVault | null): Response {
  return vault?.size ? restoreSse(response, new ChatRestorer(vault)) : response;
}
