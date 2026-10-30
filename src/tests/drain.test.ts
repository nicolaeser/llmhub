import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { drainServer, holdShutdown, isDraining, isGatewayRequest, trackRequests } from "@/lib/http/drain";

test("gateway requests are told apart from console and probe requests", () => {
  for (const url of [
    "/api/v1/messages",
    "/api/v1/chat/completions?beta=true",
    "/api/subscription/v1/responses",
    "/subscription/v1/messages",
    "/v1/models",
  ]) {
    assert.equal(isGatewayRequest(url), true, url);
  }
  for (const url of ["/internal-api/ready", "/internal-api/live", "/providers", "/api/mgmt/keys", undefined]) {
    assert.equal(isGatewayRequest(url), false, String(url));
  }
});

test("a drain waits for open gateway requests and bookkeeping, then closes the listener and exits", async () => {
  trackRequests();
  let streaming: ServerResponse | null = null;
  const server = createServer((req, res) => {
    if (req.url === "/api/v1/messages") {
      streaming = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: ping\n\n");
      return;
    }
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stream = await fetch(`${base}/api/v1/messages`, { method: "POST" });
  const reader = stream.body!.getReader();
  await reader.read();

  let exitCode: number | null = null;
  let replacingAsked = false;
  const drained = drainServer("SIGTERM", {
    replacing: async () => {
      replacingAsked = true;
      return true;
    },
    exit: (code) => {
      exitCode = code;
    },
    pollMs: 5,
    settleMs: 0,
  });
  assert.equal(isDraining(), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(replacingAsked, true);
  assert.equal(exitCode, null);
  assert.equal(server.listening, true);
  assert.equal(await (await fetch(`${base}/internal-api/ready`)).text(), "ok");

  let finishBooking = () => {};
  holdShutdown(new Promise<void>((resolve) => (finishBooking = resolve)));
  streaming!.end("event: done\n\n");
  for (;;) if ((await reader.read()).done) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(exitCode, null);

  finishBooking();
  await drained;
  assert.equal(exitCode, 143);
  assert.equal(server.listening, false);
});
