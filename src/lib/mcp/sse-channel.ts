import { McpError } from "@/lib/mcp/errors";
import { sseEvents } from "@/lib/mcp/sse";
import { cancelQuietly } from "@/lib/utils/streams";
import type { JsonMap } from "@/types/gateway";
import type { JsonRpcMessage, McpSseEvent } from "@/types/mcp";

const STREAM_BUDGET_FACTOR = 32;

type Send = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
) => Promise<Response>;

type Pending = {
  resolve: (message: JsonRpcMessage) => void;
  reject: (err: unknown) => void;
};

type ChannelOptions = {
  url: string;
  send: Send;
  maxBytes: number;
  parse: (data: string) => JsonRpcMessage[];
  answer: (message: JsonRpcMessage) => JsonMap | null;
};

export class SseChannel {
  private endpoint = "";
  private failure: unknown = null;
  private readonly pending = new Map<string | number, Pending>();
  private readonly controller = new AbortController();

  constructor(private readonly options: ChannelOptions) {}

  async open(signal: AbortSignal): Promise<void> {
    const stop = () => this.controller.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const res = await this.options.send(
        "GET",
        this.options.url,
        { Accept: "text/event-stream" },
        undefined,
        this.controller.signal,
      );
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!res.ok || !res.body || !type.includes("text/event-stream")) {
        await cancelQuietly(res.body);
        throw new McpError("MCP_HTTP_ERROR", `HTTP ${res.status}`);
      }
      const events = sseEvents(res.body, {
        total: this.options.maxBytes * STREAM_BUDGET_FACTOR,
        event: this.options.maxBytes,
      });
      await new Promise<void>((resolve, reject) => {
        void this.pump(events, (err) => (err ? reject(err) : resolve()));
      });
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  private endpointOf(data: string): string {
    const text = data.trim();
    if (!text || !URL.canParse(text, this.options.url)) return "";
    const resolved = new URL(text, this.options.url);
    return resolved.origin === new URL(this.options.url).origin ? resolved.toString() : "";
  }

  private async pump(events: AsyncGenerator<McpSseEvent>, ready: (err?: unknown) => void): Promise<void> {
    let opened = false;
    try {
      for await (const event of events) {
        if (event.event === "endpoint" && !opened) {
          this.endpoint = this.endpointOf(event.data);
          if (!this.endpoint) throw new McpError("MCP_PROTOCOL_ERROR", "invalid endpoint");
          opened = true;
          ready();
          continue;
        }
        if (event.event !== "message" || !event.data.trim()) continue;
        let messages: JsonRpcMessage[] = [];
        try {
          messages = this.options.parse(event.data);
        } catch (err) {
          if (!(err instanceof McpError)) throw err;
        }
        for (const message of messages) await this.deliver(message);
      }
      throw new McpError("MCP_PROTOCOL_ERROR", opened ? "stream closed" : "no endpoint event");
    } catch (err) {
      this.fail(err);
      if (!opened) ready(err);
    }
  }

  private async deliver(message: JsonRpcMessage): Promise<void> {
    if (message.id === undefined || message.id === null) return;
    if (message.method === undefined) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      waiting.resolve(message);
      return;
    }
    const reply = this.options.answer(message);
    if (!reply || !this.endpoint) return;
    const res = await this.options
      .send("POST", this.endpoint, { "Content-Type": "application/json" }, JSON.stringify(reply), AbortSignal.timeout(5_000))
      .catch(() => null);
    await cancelQuietly(res?.body);
  }

  async request(payload: JsonMap & { id: string | number }, signal: AbortSignal): Promise<JsonRpcMessage> {
    if (this.failure) throw this.failure;
    const id = payload.id;
    let rejectAnswer: (err: unknown) => void = () => undefined;
    const answer = new Promise<JsonRpcMessage>((resolve, reject) => {
      rejectAnswer = reject;
      this.pending.set(id, { resolve, reject });
    });
    void answer.catch(() => null);
    const stop = () => rejectAnswer(signal.reason ?? new McpError("MCP_TIMEOUT"));
    signal.addEventListener("abort", stop, { once: true });
    try {
      await this.post(payload, signal);
      return await answer;
    } finally {
      this.pending.delete(id);
      signal.removeEventListener("abort", stop);
    }
  }

  async post(payload: JsonMap, signal: AbortSignal): Promise<void> {
    if (this.failure) throw this.failure;
    const res = await this.options.send(
      "POST",
      this.endpoint,
      { "Content-Type": "application/json" },
      JSON.stringify(payload),
      signal,
    );
    await cancelQuietly(res.body);
    if (!res.ok) throw new McpError("MCP_HTTP_ERROR", `HTTP ${res.status}`);
  }

  private fail(err: unknown): void {
    this.failure ??= err;
    for (const waiting of this.pending.values()) waiting.reject(this.failure);
    this.pending.clear();
  }

  close(): void {
    this.fail(new McpError("MCP_PROTOCOL_ERROR", "closed"));
    this.controller.abort();
  }
}
