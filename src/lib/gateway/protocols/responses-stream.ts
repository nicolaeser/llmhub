import { asRecord, newId } from "@/lib/gateway/core";
import { ToolCallDeltas } from "@/lib/gateway/protocols/chat-stream";
import {
  encodeThinking,
  incompleteReason,
  outputText,
  responsesUsage,
  textPart,
  visibleItem,
  visibleResponse,
} from "@/lib/gateway/protocols/responses";
import { sseEvent } from "@/lib/gateway/protocols/sse";
import type { JsonMap } from "@/types/gateway";
import type { ChatStreamEncoder, ToolCallEvent } from "@/types/responses";

export class ResponsesStreamEncoder implements ChatStreamEncoder {
  private seq = 0;
  private items: JsonMap[] = [];
  private message: { item: JsonMap; index: number; text: string } | null = null;
  private reasoning: { item: JsonMap; index: number; text: string; blocks: JsonMap[]; part: boolean } | null =
    null;
  private calls = new Map<number, { item: JsonMap; index: number }>();
  private openCall: number | null = null;
  private deltas = new ToolCallDeltas();
  private finishReason: unknown = null;
  private usage: unknown = null;
  private response: JsonMap;

  constructor(
    base: JsonMap,
    private include: string[] | null = null,
  ) {
    this.response = { ...base, status: "in_progress", output: [], output_text: "", usage: null };
  }

  result(): JsonMap {
    return this.response;
  }

  private visible(response: JsonMap): JsonMap {
    return visibleResponse(response, this.include);
  }

  private openReasoning(): string[] {
    if (this.reasoning) return [];
    const out = [...this.closeMessage("completed"), ...this.closeCall()];
    const item: JsonMap = { id: `rs_${newId()}`, type: "reasoning", summary: [] };
    this.reasoning = { item, index: this.items.length, text: "", blocks: [], part: false };
    this.items.push(item);
    out.push(this.event("response.output_item.added", { output_index: this.reasoning.index, item: { ...item } }));
    return out;
  }

  private reason(delta: string): string[] {
    const out = this.openReasoning();
    const open = this.reasoning!;
    const ids = { item_id: open.item.id, output_index: open.index, summary_index: 0 };
    if (!open.part) {
      open.part = true;
      out.push(
        this.event("response.reasoning_summary_part.added", { ...ids, part: { type: "summary_text", text: "" } }),
      );
    }
    open.text += delta;
    out.push(this.event("response.reasoning_summary_text.delta", { ...ids, delta }));
    return out;
  }

  private thinkingBlocks(blocks: unknown): string[] {
    if (!Array.isArray(blocks)) return [];
    const valid = blocks.filter((item): item is JsonMap => asRecord(item) !== null);
    if (!valid.length) return [];
    const out = this.openReasoning();
    this.reasoning!.blocks.push(...valid);
    return out;
  }

  private closeReasoning(): string[] {
    const open = this.reasoning;
    if (!open) return [];
    this.reasoning = null;
    const out: string[] = [];
    const ids = { item_id: open.item.id, output_index: open.index, summary_index: 0 };
    if (open.part) {
      const part = { type: "summary_text", text: open.text };
      out.push(
        this.event("response.reasoning_summary_text.done", { ...ids, text: open.text }),
        this.event("response.reasoning_summary_part.done", { ...ids, part }),
      );
      open.item.summary = [part];
    }
    if (open.blocks.length) open.item.encrypted_content = encodeThinking(open.blocks);
    out.push(
      this.event("response.output_item.done", {
        output_index: open.index,
        item: visibleItem(open.item, this.include),
      }),
    );
    return out;
  }

  private event(type: string, payload: JsonMap): string {
    return sseEvent(type, { type, sequence_number: this.seq++, ...payload });
  }

  start(): string[] {
    return [
      this.event("response.created", { response: this.visible(this.response) }),
      this.event("response.in_progress", { response: this.visible(this.response) }),
    ];
  }

  private closeMessage(status: string): string[] {
    const open = this.message;
    if (!open) return [];
    this.message = null;
    const part = textPart(open.text);
    open.item.status = status;
    open.item.content = [part];
    const ids = { item_id: open.item.id, output_index: open.index, content_index: 0 };
    return [
      this.event("response.output_text.done", { ...ids, text: open.text, logprobs: [] }),
      this.event("response.content_part.done", { ...ids, part }),
      this.event("response.output_item.done", { output_index: open.index, item: open.item }),
    ];
  }

  private closeCall(): string[] {
    const slot = this.openCall;
    this.openCall = null;
    const call = slot === null ? undefined : this.calls.get(slot);
    if (!call) return [];
    call.item.status = "completed";
    return [
      this.event("response.function_call_arguments.done", {
        item_id: call.item.id,
        output_index: call.index,
        name: call.item.name,
        arguments: call.item.arguments,
      }),
      this.event("response.output_item.done", { output_index: call.index, item: call.item }),
    ];
  }

  private text(delta: string): string[] {
    const out: string[] = [];
    if (!this.message) {
      out.push(...this.closeReasoning(), ...this.closeCall());
      const item: JsonMap = {
        id: `msg_${newId()}`,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      };
      this.message = { item, index: this.items.length, text: "" };
      this.items.push(item);
      out.push(this.event("response.output_item.added", { output_index: this.message.index, item: { ...item } }));
      out.push(
        this.event("response.content_part.added", {
          item_id: item.id,
          output_index: this.message.index,
          content_index: 0,
          part: textPart(""),
        }),
      );
    }
    this.message.text += delta;
    out.push(
      this.event("response.output_text.delta", {
        item_id: this.message.item.id,
        output_index: this.message.index,
        content_index: 0,
        delta,
        logprobs: [],
      }),
    );
    return out;
  }

  private tool(event: ToolCallEvent): string[] {
    if (event.type === "start") {
      const out = [...this.closeReasoning(), ...this.closeMessage("completed"), ...this.closeCall()];
      const item: JsonMap = {
        id: `fc_${newId()}`,
        type: "function_call",
        status: "in_progress",
        call_id: event.id,
        name: event.name,
        arguments: "",
      };
      const index = this.items.length;
      this.items.push(item);
      this.calls.set(event.slot, { item, index });
      this.openCall = event.slot;
      out.push(this.event("response.output_item.added", { output_index: index, item: { ...item } }));
      return out;
    }
    const call = this.calls.get(event.slot);
    if (!call) return [];
    call.item.arguments = `${String(call.item.arguments ?? "")}${event.delta}`;
    return [
      this.event("response.function_call_arguments.delta", {
        item_id: call.item.id,
        output_index: call.index,
        delta: event.delta,
      }),
    ];
  }

  beginItem(item: JsonMap, progress: string[]): { index: number; events: string[] } {
    const out = [...this.closeReasoning(), ...this.closeMessage("completed"), ...this.closeCall()];
    const index = this.items.length;
    this.items.push(item);
    out.push(this.event("response.output_item.added", { output_index: index, item: { ...item } }));
    for (const type of progress) out.push(this.event(type, { output_index: index, item_id: item.id }));
    return { index, events: out };
  }

  endItem(index: number, item: JsonMap, progress: string[]): string[] {
    this.items[index] = item;
    return [
      ...progress.map((type) => this.event(type, { output_index: index, item_id: item.id })),
      this.event("response.output_item.done", { output_index: index, item }),
    ];
  }

  push(chunk: JsonMap): string[] {
    const out: string[] = [];
    if (asRecord(chunk.usage)) this.usage = chunk.usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = asRecord(choices.find((c) => Number(asRecord(c)?.index ?? 0) === 0));
    if (!choice) return out;
    const delta = asRecord(choice.delta);
    const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
    if (reasoning) out.push(...this.reason(reasoning));
    out.push(...this.thinkingBlocks(delta?.thinking_blocks));
    const text = typeof delta?.content === "string" ? delta.content : "";
    if (text) out.push(...this.text(text));
    for (const event of this.deltas.push(delta?.tool_calls)) out.push(...this.tool(event));
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  finish(): string[] {
    const out: string[] = [];
    for (const event of this.deltas.flush()) out.push(...this.tool(event));
    const incomplete = incompleteReason(this.finishReason);
    out.push(
      ...this.closeReasoning(),
      ...this.closeMessage(incomplete ? "incomplete" : "completed"),
      ...this.closeCall(),
    );
    this.response = {
      ...this.response,
      status: incomplete ? "incomplete" : "completed",
      incomplete_details: incomplete ? { reason: incomplete } : null,
      output: this.items,
      output_text: outputText(this.items),
      usage: responsesUsage(this.usage),
    };
    out.push(
      this.event(incomplete ? "response.incomplete" : "response.completed", {
        response: this.visible(this.response),
      }),
    );
    return out;
  }

  fail(message: string): string[] {
    this.response = {
      ...this.response,
      status: "failed",
      error: { code: "server_error", message },
      output: this.items,
      output_text: outputText(this.items),
      usage: this.usage ? responsesUsage(this.usage) : null,
    };
    return [this.event("response.failed", { response: this.visible(this.response) })];
  }
}
