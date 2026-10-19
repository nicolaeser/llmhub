import { asRecord, newId } from "@/lib/gateway/core";
import { KEEPALIVE_MS, SSE_HEADERS, SSE_KEEPALIVE } from "@/lib/gateway/protocols/sse";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { cancelQuietly, DeadlineReader } from "@/lib/utils/streams";
import type { JsonMap } from "@/types/gateway";
import type { ChatStreamEncoder, ToolCallEntry, ToolCallEvent } from "@/types/responses";

function streamErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "upstream stream error";
}

export function pipeChatStream(
  res: Response,
  encoder: ChatStreamEncoder,
  onDone?: () => Promise<void> | void,
  options: { keepAliveMs?: number } = {},
): Response {
  const bytes = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = res.body?.getReader() ?? null;
  const reads = reader ? new DeadlineReader(reader) : null;
  const keepAliveMs = options.keepAliveMs ?? KEEPALIVE_MS;
  let started = false;
  let failed = false;
  let leftover = "";
  let lastSent = Date.now();

  const lineEvents = (raw: string): string[] => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return [];
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    let json: JsonMap;
    try {
      json = JSON.parse(data) as JsonMap;
    } catch {
      return [];
    }
    const err = asRecord(json.error);
    if (err && !Array.isArray(json.choices)) {
      failed = true;
      return encoder.fail(typeof err.message === "string" ? err.message : "upstream error");
    }
    return failed ? [] : encoder.push(json);
  };

  const complete = async (controller: ReadableStreamDefaultController<Uint8Array>, events: string[]) => {
    for (const event of events) controller.enqueue(bytes.encode(event));
    try {
      await onDone?.();
    } catch (err) {
      logger.error("gateway.stream_finish_failed", errorFields(err));
    }
    controller.close();
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const out: string[] = [];
      if (!started) {
        started = true;
        out.push(...encoder.start());
      }
      if (!reads) {
        await complete(controller, [...out, ...encoder.finish()]);
        return;
      }
      try {
        while (!out.length) {
          const read = await reads.read(lastSent + keepAliveMs - Date.now());
          if (!read) {
            out.push(encoder.keepAlive?.() ?? SSE_KEEPALIVE);
            break;
          }
          const { done, value } = read;
          if (done) {
            leftover += decoder.decode();
            for (const line of leftover.split("\n")) out.push(...lineEvents(line));
            leftover = "";
            if (!failed) out.push(...encoder.finish());
            await complete(controller, out);
            return;
          }
          leftover += decoder.decode(value, { stream: true });
          const parts = leftover.split("\n");
          leftover = parts.pop() ?? "";
          for (const line of parts) out.push(...lineEvents(line));
        }
      } catch (err) {
        if (!failed) out.push(...encoder.fail(streamErrorMessage(err)));
        failed = true;
        await complete(controller, out);
        return;
      }
      for (const event of out) controller.enqueue(bytes.encode(event));
      lastSent = Date.now();
    },
    cancel() {
      void cancelQuietly(reader);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export class ToolCallDeltas {
  private calls = new Map<number, ToolCallEntry>();
  private next = 0;

  private start(entry: ToolCallEntry): ToolCallEvent[] {
    entry.started = true;
    if (!entry.id) entry.id = `call_${newId()}`;
    const out: ToolCallEvent[] = [{ type: "start", slot: entry.slot, id: entry.id, name: entry.name }];
    if (entry.args) out.push({ type: "args", slot: entry.slot, delta: entry.args });
    return out;
  }

  push(toolCalls: unknown): ToolCallEvent[] {
    if (!Array.isArray(toolCalls)) return [];
    const out: ToolCallEvent[] = [];
    toolCalls.forEach((raw, position) => {
      const call = asRecord(raw);
      if (!call) return;
      const fn = asRecord(call.function);
      const key = typeof call.index === "number" ? call.index : position;
      const id = typeof call.id === "string" ? call.id : "";
      let entry = this.calls.get(key);
      if (!entry || (id && entry.id && id !== entry.id)) {
        entry = { id, name: "", args: "", started: false, slot: this.next++ };
        this.calls.set(key, entry);
      }
      if (id && !entry.id) entry.id = id;
      const args =
        typeof fn?.arguments === "string"
          ? fn.arguments
          : asRecord(fn?.arguments)
            ? JSON.stringify(fn?.arguments)
            : "";
      if (entry.started) {
        if (args) out.push({ type: "args", slot: entry.slot, delta: args });
        return;
      }
      if (typeof fn?.name === "string" && fn.name) entry.name = fn.name;
      entry.args += args;
      if (entry.name) out.push(...this.start(entry));
    });
    return out;
  }

  flush(): ToolCallEvent[] {
    const out: ToolCallEvent[] = [];
    const pending = [...this.calls.values()].filter((entry) => !entry.started);
    pending.sort((a, b) => a.slot - b.slot);
    for (const entry of pending) out.push(...this.start(entry));
    return out;
  }
}
