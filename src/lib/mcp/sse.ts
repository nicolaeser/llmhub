import { McpError } from "@/lib/mcp/errors";
import { cancelQuietly } from "@/lib/utils/streams";
import type { McpSseEvent } from "@/types/mcp";

const LINE_END = /\r\n|\r|\n/;

async function* readChunks(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new McpError("MCP_RESPONSE_TOO_LARGE");
      yield decoder.decode(value, { stream: true });
    }
    drained = true;
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    if (!drained) await cancelQuietly(reader);
  }
}

export async function readLimitedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  let text = "";
  for await (const chunk of readChunks(res.body, maxBytes)) text += chunk;
  return text;
}

export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  limits: { total: number; event: number },
): AsyncGenerator<McpSseEvent> {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | null = null;
  let retry: number | null = null;
  let fields = false;
  let size = 0;

  const take = (line: string): McpSseEvent | null => {
    if (line === "") {
      if (!fields) return null;
      const out = { event: event || "message", data: data.join("\n"), id, retry };
      event = "";
      data = [];
      id = null;
      retry = null;
      fields = false;
      size = 0;
      return out;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (name === "data") {
      size += value.length + 1;
      if (size > limits.event) throw new McpError("MCP_RESPONSE_TOO_LARGE");
      data.push(value);
      fields = true;
    } else if (name === "event") {
      event = value;
      fields = true;
    } else if (name === "id" && !value.includes("\0")) {
      id = value;
      fields = true;
    } else if (name === "retry" && /^\d{1,9}$/.test(value)) {
      retry = Number(value);
      fields = true;
    }
    return null;
  };

  const lines = function* (final: boolean): Generator<McpSseEvent> {
    for (;;) {
      const match = LINE_END.exec(buffer);
      if (!match) break;
      if (!final && match[0] === "\r" && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const out = take(line);
      if (out) yield out;
    }
    if (buffer.length > limits.event) throw new McpError("MCP_RESPONSE_TOO_LARGE");
    if (!final) return;
    const rest = buffer;
    buffer = "";
    for (const line of rest ? [rest, ""] : [""]) {
      const out = take(line);
      if (out) yield out;
    }
  };

  for await (const chunk of readChunks(body, limits.total)) {
    buffer += chunk;
    yield* lines(false);
  }
  yield* lines(true);
}
