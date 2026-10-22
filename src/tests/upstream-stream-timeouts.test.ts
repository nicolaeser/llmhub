import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import type { ResolvedDeployment, ResolvedModelGroup } from "@/types/routing";

type Upstream = (req: IncomingMessage, res: ServerResponse) => void;

let handler: Upstream = (_req, res) => res.end();
const closed: string[] = [];
const server = createServer((req, res) => {
  req.on("close", () => closed.push(req.url ?? ""));
  handler(req, res);
});
const ready = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

after(() => {
  server.closeAllConnections();
  server.close();
});

async function deployment(): Promise<ResolvedDeployment> {
  return {
    id: "stream-timeouts",
    kind: "openai_compat",
    base_url: `http://127.0.0.1:${await ready}/v1`,
    model: "local",
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: "",
  };
}

const group = { strategy: "priority" } as ResolvedModelGroup;

function chunk(n: number): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: String(n) }, finish_reason: null }] })}\n\n`;
}

async function open(timeouts: { headersMs?: number; idleMs?: number }, req = new Request("http://hub.local/")) {
  const { openUpstreamStream } = await import("@/lib/gateway/dispatch/chat");
  return openUpstreamStream({
    dep: await deployment(),
    group,
    req,
    path: "/chat/completions",
    payload: { model: "local", stream: true, messages: [] },
    timeouts,
  });
}

test("a stream that keeps sending runs past the header timeout without a total limit", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(chunk(sent++));
      if (sent === 8) {
        clearInterval(timer);
        res.end("data: [DONE]\n\n");
      }
    }, 100);
  };
  await (await open({ headersMs: 10_000, idleMs: 10_000 })).text();
  const started = Date.now();
  const res = await open({ headersMs: 400, idleMs: 2_000 });
  const text = await res.text();
  assert.ok(Date.now() - started >= 600, "the stream outlived the header timeout");
  assert.equal((text.match(/"content":"/g) ?? []).length, 8);
  assert.match(text, /\[DONE\]$/m);
});

test("a stream that goes silent fails with an upstream timeout and closes the upstream connection", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk(0));
  };
  const before = closed.length;
  const res = await open({ headersMs: 10_000, idleMs: 300 });
  const reader = res.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"content":"0"/);
  const { GateError } = await import("@/lib/gateway/errors");
  await assert.rejects(reader.read(), (err: unknown) => err instanceof GateError && err.status === 504 && err.code === "upstream_timeout");
  for (let wait = 0; wait < 50 && closed.length === before; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed.length, before + 1);
});

test("an upstream that never sends headers times out as a gateway timeout", async () => {
  handler = () => {};
  const { toGateError } = await import("@/lib/gateway/access/gate");
  const failure = await open({ headersMs: 80, idleMs: 1_000 }).catch((err: unknown) => err);
  const gate = toGateError(failure);
  assert.equal(gate.status, 504);
  assert.equal(gate.code, "upstream_timeout");
});

test("a client that hangs up still aborts the upstream after the headers arrived", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk(0));
  };
  const client = new AbortController();
  const before = closed.length;
  const res = await open({ headersMs: 1_000, idleMs: 5_000 }, new Request("http://hub.local/", { signal: client.signal }));
  const reader = res.body!.getReader();
  await reader.read();
  client.abort();
  await assert.rejects(reader.read());
  for (let wait = 0; wait < 50 && closed.length === before; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed.length, before + 1);
});
