import assert from "node:assert/strict";
import test from "node:test";
import { relayEvent, relaySse } from "@/lib/gateway/protocols/sse";
import type { JsonMap } from "@/types/gateway";

function chunked(text: string, size = 5): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

test("relaySse rewrites JSON events across chunk boundaries and reports the end", async () => {
  const seen: string[] = [];
  let ended = 0;
  const res = relaySse(
    chunked(
      'event: message_start\r\ndata: {"type":"message_start","message":{"model":"claude-x"}}\r\n\r\n' +
        ": keepalive\n\n" +
        'event: ping\ndata: {"type": "ping"}\n\n' +
        "data: [DONE]\n\n",
    ),
    {
      map: (json, event) => {
        seen.push(event);
        if (event === "message_start") (json.message as JsonMap).model = "alias";
        return event === "ping" ? null : json;
      },
      onEnd: () => {
        ended += 1;
      },
    },
  );
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await res.text();
  assert.equal(
    text,
    'event: message_start\ndata: {"type":"message_start","message":{"model":"alias"}}\n\n' +
      ": keepalive\n\n" +
      "data: [DONE]\n\n",
  );
  assert.deepEqual(seen, ["message_start", "ping"]);
  assert.equal(ended, 1);
});

test("relayEvent names data-only events by their type field", () => {
  const types: string[] = [];
  const out = relayEvent('data: {"type":"image_generation.completed","usage":{"input_tokens":3}}', {
    map: (json, event) => {
      types.push(event);
      return json;
    },
  });
  assert.deepEqual(types, ["image_generation.completed"]);
  assert.equal(out, 'data: {"type":"image_generation.completed","usage":{"input_tokens":3}}\n\n');
  assert.equal(relayEvent("data: one\ndata: two", {}), "data: one\ntwo\n\n");
});

test("relaySse ends the client stream before slow end bookkeeping settles", async () => {
  let release = () => {};
  const steps: string[] = [];
  const res = relaySse(chunked('event: message_stop\ndata: {"type":"message_stop"}\n\n'), {
    onEnd: async () => {
      steps.push("end started");
      await new Promise<void>((resolve) => (release = resolve));
      steps.push("end finished");
    },
  });
  const body = res.text();
  const text = await Promise.race([body, new Promise<null>((resolve) => setTimeout(resolve, 1000, null))]);
  steps.push("client done");
  release();
  await body;
  assert.equal(text, 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
  assert.deepEqual(steps.slice(0, 2), ["end started", "client done"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ["end started", "client done", "end finished"]);
});
