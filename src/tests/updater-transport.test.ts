import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { dockerClient, DockerError } from "../../scripts/updater/docker.mjs";
import { readText, send } from "../../scripts/updater/http.mjs";
import { imageRefOf, parseImageRef } from "../../scripts/updater/image-ref.mjs";

async function daemon(t: TestContext, handler: RequestListener) {
  const directory = await mkdtemp(join(tmpdir(), "updater-transport-"));
  const socketPath = join(directory, "docker.sock");
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, docker: dockerClient(socketPath) };
}

test("transport deadline covers waiting for response headers", async (t) => {
  const { socketPath } = await daemon(t, () => undefined);
  await assert.rejects(send({ socketPath, method: "GET", path: "/", timeout: 1000, deadline: 40 }), /deadline exceeded/);
});

test("transport deadline bounds a continuously active response", async (t) => {
  let writes = 0;
  const { socketPath } = await daemon(t, (_req, res) => {
    res.writeHead(200);
    res.write("first");
    const timer = setInterval(() => { writes += 1; res.write("more"); }, 10);
    res.on("close", () => clearInterval(timer));
  });
  const res = await send({ socketPath, method: "GET", path: "/", timeout: 5000, deadline: 1000 });
  await assert.rejects(readText(res), /aborted|deadline|reset/i);
  assert.ok(writes > 1, "response must remain active before the total deadline expires");
});

test("transport idle timeout still bounds a stalled response", async (t) => {
  const { socketPath } = await daemon(t, (_req, res) => res.write("first"));
  const res = await send({ socketPath, method: "GET", path: "/", timeout: 40, deadline: 1000 });
  await assert.rejects(readText(res), /aborted|timed out|reset/i);
});

test("transport refuses oversized bodies and truncated responses", async (t) => {
  const { socketPath } = await daemon(t, (req, res) => {
    if (req.url === "/large") return void res.end("12345");
    res.writeHead(200, { "Content-Length": 20 });
    res.write("short");
    setImmediate(() => res.destroy());
  });
  await assert.rejects(readText(await send({ socketPath, path: "/large" }), 4), /too large/);
  await assert.rejects(readText(await send({ socketPath, path: "/truncated" })), /aborted|reset/i);
});

test("Docker calls reject malformed JSON and preserve typed missing responses", async (t) => {
  const { docker } = await daemon(t, (req, res) => {
    if (req.url?.includes("missing")) {
      res.writeHead(404);
      return void res.end('{"message":"not found"}');
    }
    res.end("not JSON");
  });
  assert.equal(await docker.inspectContainer("missing"), null);
  await assert.rejects(docker.inspectImage("broken"), /invalid Docker JSON/);
});

test("pull parses split UTF-8 events and final lines and forwards platform", async (t) => {
  const { docker } = await daemon(t, (req, res) => {
    const url = new URL(req.url!, "http://docker");
    assert.equal(url.searchParams.get("fromImage"), "registry.test/repo");
    assert.equal(url.searchParams.get("tag"), "latest");
    assert.equal(url.searchParams.get("platform"), "linux/arm64/v8");
    const event = Buffer.from('{"status":"Status: café downloaded"}');
    const split = event.indexOf(Buffer.from("é")) + 1;
    res.write(event.subarray(0, split));
    setImmediate(() => res.end(event.subarray(split)));
  });
  assert.equal(await docker.pull("registry.test/repo", "latest", { platform: "linux/arm64/v8" }), "Status: café downloaded");
});

test("pull fails immediately on daemon error even if daemon never closes stream", { timeout: 2000 }, async (t) => {
  const { docker } = await daemon(t, (_req, res) => {
    res.write('{"errorDetail":{"message":"disk full"}}\n');
  });
  await assert.rejects(docker.pull("repo", "latest"), (error: unknown) => error instanceof DockerError && error.message === "disk full");
});

for (const [name, body, error] of [
  ["empty", "", /empty image pull/],
  ["malformed", "not JSON\n", /invalid image pull/],
  ["oversized", "x".repeat(1024 * 1024 + 1), /too large/],
] as const) {
  test(`pull rejects ${name} responses`, async (t) => {
    const { docker } = await daemon(t, (_req, res) => res.end(body));
    await assert.rejects(docker.pull("repo", "latest"), error);
  });
}

test("image deletion never forces deletion or prunes unselected parents", async (t) => {
  const { docker } = await daemon(t, (req, res) => {
    assert.equal(req.method, "DELETE");
    const url = new URL(req.url!, "http://docker");
    assert.equal(url.searchParams.get("force"), "false");
    assert.equal(url.searchParams.get("noprune"), "true");
    res.end("[]");
  });
  await docker.removeImage("sha256:unused");
});

test("image references retain digest pins and registry ports", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const parsed = parseImageRef(`localhost:5000/repo:latest@${digest}`);
  assert.ok(parsed);
  assert.equal(imageRefOf(parsed), `localhost:5000/repo@${digest}`);
  assert.equal(imageRefOf({ name: "localhost:5000/repo", tag: null }), "localhost:5000/repo:latest");
});

test("pull reports bounded real download progress without counting extraction or cached bytes", async (t) => {
  const progress: { downloadedBytes: number; totalBytes: number | null; layersCompleted: number; layersTotal: number }[] = [];
  const { docker } = await daemon(t, (_req, res) => {
    const events = [
      { id: "a", status: "Pulling fs layer" },
      ...Array.from({ length: 1000 }, (_, current) => ({ id: "a", status: "Downloading", progressDetail: { current, total: 1000 } })),
      { id: "a", status: "Download complete" },
      { id: "a", status: "Extracting", progressDetail: { current: 50000, total: 100000 } },
      { id: "a", status: "Pull complete" },
      { id: "b", status: "Already exists" },
    ];
    res.end(events.map((event) => JSON.stringify(event)).join("\n"));
  });
  await docker.pull("repo", "latest", { onProgress: (value: typeof progress[number]) => progress.push(value) });
  assert.ok(progress.length <= 2);
  assert.equal(progress[0].totalBytes, null);
  assert.deepEqual(progress.at(-1), { downloadedBytes: 1000, totalBytes: 1000, layersCompleted: 2, layersTotal: 2 });
});

test("pull retains unknown totals when Docker omits download sizes", async (t) => {
  const progress: unknown[] = [];
  const { docker } = await daemon(t, (_req, res) => res.end('{"id":"a","status":"Pull complete"}\n'));
  await docker.pull("repo", "latest", { onProgress: (value: unknown) => progress.push(value) });
  assert.deepEqual(progress.at(-1), { downloadedBytes: 0, totalBytes: null, layersCompleted: 1, layersTotal: 1 });
});
