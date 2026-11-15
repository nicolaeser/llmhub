import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgent } from "../../scripts/updater/agent.mjs";
import { signBody, updaterKey, UPDATER_HEADER } from "../../scripts/updater/signature.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const key = updaterKey("agent-regression-test-secret-123456");
const command = { id: "command-12345", action: "check" };

async function harness() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "updater-agent-"));
  let wanted: typeof command | null = command;
  const reports: Record<string, unknown>[] = [];
  let hold = false;
  const held: (() => void)[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const report = JSON.parse(body);
    reports.push(report);
    if (report.ackCommandId === wanted?.id) wanted = null;
    const text = JSON.stringify({ auto: false, command: wanted });
    response.setHeader(UPDATER_HEADER, signBody(key, text, Date.now(), "response"));
    if (hold) held.push(() => response.end(text));
    else response.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const app = { Id: "app", Name: "/test-app", Image: "image", State: { Running: true }, Config: { Image: "example/app:latest", Labels: { "com.docker.compose.project": "test", "com.docker.compose.service": "app", "llmhub.updater.target": "true" } } };
  const self = { Id: hostname(), Name: "/test-updater", Image: "image", Config: { Labels: { "com.docker.compose.project": "test" } } };
  let checks = 0;
  const docker = {
    inspectContainer: async (id: string) => id === "app" ? app : id === self.Id ? self : null,
    listContainers: async () => [{ Id: "app" }],
    inspectImage: async () => ({ Id: "image", RepoDigests: [`example/app@${digest}`] }),
    distribution: async () => { checks += 1; return { Descriptor: { digest } }; },
  };
  const options = { docker, key, stateDir, appUrl: new URL(`http://127.0.0.1:${address.port}`), version: "test", diskSpace: async () => ({ freeBytes: 10 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 }) };
  return { options, reports, holdReports: () => { hold = true; }, releaseReports: () => { hold = false; held.splice(0).forEach((send) => send()); }, checks: () => checks, clearCommand: () => { wanted = null; }, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(stateDir, { recursive: true, force: true });
  } };
}

test("accepted commands are journaled before acknowledgement and removed only after completion", async () => {
  const h = await harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const distribution = h.options.docker.distribution;
  h.options.docker.distribution = async () => { await gate; return distribution(); };
  const agent = createAgent(h.options);
  try {
    await agent.start();
    const saved = JSON.parse(await readFile(path.join(h.options.stateDir, "state.json"), "utf8"));
    assert.deepEqual(saved.pendingCommand, command);
    await agent.tick();
    assert.ok(h.reports.some((report) => report.ackCommandId === command.id));
    release();
    await agent.stop();
    const finished = JSON.parse(await readFile(path.join(h.options.stateDir, "state.json"), "utf8"));
    assert.equal(finished.pendingCommand, null);
    assert.equal(finished.lastResult.commandId, command.id);
    assert.equal(h.checks(), 1);
  } finally { release(); await agent.stop(); await h.close(); }
});

test("restart resumes a persisted command even after the app has cleared it", async () => {
  const h = await harness();
  h.clearCommand();
  await writeFile(path.join(h.options.stateDir, "state.json"), JSON.stringify({ ackCommandId: command.id, pendingCommand: command }));
  const agent = createAgent(h.options);
  try {
    await agent.start();
    await agent.stop();
    assert.equal(h.checks(), 1);
    assert.equal(JSON.parse(await readFile(path.join(h.options.stateDir, "state.json"), "utf8")).lastResult.commandId, command.id);
  } finally { await agent.stop(); await h.close(); }
});

test("failed startup recovery is retried before commands execute", async () => {
  const h = await harness();
  const list = h.options.docker.listContainers;
  let attempts = 0;
  h.options.docker.listContainers = async () => {
    if (++attempts === 1) throw Object.assign(new Error("daemon unavailable"), { code: "ECONNREFUSED" });
    return list();
  };
  const agent = createAgent(h.options);
  try {
    await agent.start();
    assert.equal(h.checks(), 0);
    await agent.tick();
    await agent.stop();
    assert.equal(h.checks(), 1);
    assert.ok(attempts >= 3);
  } finally { await agent.stop(); await h.close(); }
});

test("a manual check postpones the scheduled check instead of immediately repeating it", async () => {
  const h = await harness();
  const agent = createAgent(h.options);
  try {
    await agent.start();
    await agent.stop();
    await agent.tick();
    await agent.stop();
    assert.equal(h.checks(), 1);
  } finally { await agent.stop(); await h.close(); }
});

test("phase reporting cannot block Docker checks when the app does not respond", { timeout: 3000 }, async () => {
  const h = await harness();
  h.holdReports();
  const agent = createAgent(h.options);
  try {
    await agent.check();
    assert.equal(h.checks(), 1);
    h.options.docker.listContainers = async () => [];
    await agent.check();
    assert.equal(agent.status.currentDigest, null);
    assert.equal(agent.status.latestDigest, null);
    assert.equal(agent.status.image, null);
    assert.equal(agent.status.available, false);
  } finally { h.releaseReports(); await agent.stop(); await h.close(); }
});

test("update progress exposes timestamps and totals while pulling and clears on failure", async () => {
  const h = await harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const pulling = new Promise<void>((resolve) => { reached = resolve; });
  const agent = createAgent({ ...h.options, docker: { ...h.options.docker,
    listDanglingImages: async () => [],
    pull: async () => { reached(); await gate; throw new Error("pull interrupted"); },
  } });
  const applying = agent.apply({ commandId: null, target: null });
  try {
    await pulling;
    const progress = agent.status.progress as { startedAt: string; phaseStartedAt: string; total: number; completed: number; service: string | null } | null;
    assert.ok(progress);
    assert.ok(Number.isFinite(Date.parse(progress.startedAt)));
    assert.ok(Number.isFinite(Date.parse(progress.phaseStartedAt)));
    assert.equal(progress.total, 1);
    assert.equal(progress.completed, 0);
    assert.equal(agent.status.state, "pulling");
    release();
    await applying;
    assert.equal(agent.status.progress, null);
    assert.equal(agent.status.state, "failed");
    assert.equal(agent.status.failedDigest, null);
  } finally { release(); await applying; await agent.stop(); await h.close(); }
});

test("a successor retries state inheritance without stopping its predecessor on a read failure", async () => {
  const h = await harness();
  h.clearCommand();
  const labels = { "com.docker.compose.project": "test", "com.docker.compose.service": "updater" };
  const previous = { Id: "previous", Name: "/test-updater", Config: { Labels: labels } };
  const self = { Id: "self", Name: "/test-updater-next", Config: { Labels: labels } };
  const calls: string[] = [];
  const agent = createAgent({ ...h.options, predecessor: "previous", docker: { ...h.options.docker,
    inspectContainer: async (id: string) => id === "previous" ? previous : self,
    readFile: async () => { calls.push("read"); throw new Error("archive unavailable"); },
    stop: async () => { calls.push("stop"); },
    remove: async () => { calls.push("remove"); },
  } });
  try {
    await agent.start();
    await agent.tick();
    assert.deepEqual(calls, ["read", "read"]);
    assert.equal(h.checks(), 0);
  } finally { await agent.stop(); await h.close(); }
});

test("a moving tag cannot switch containers or blacklist the checked digest and preserves platform", async () => {
  const h = await harness();
  const pulls: unknown[] = [];
  let stopped = false;
  const agent = createAgent({ ...h.options, docker: { ...h.options.docker,
    listDanglingImages: async () => [],
    inspectImage: async (ref: string) => ({ Id: "image", Os: "linux", Architecture: "arm64", Variant: "v8", RepoDigests: [`example/app@${ref === "image" ? digest : `sha256:${"b".repeat(64)}`}`] }),
    pull: async (...args: unknown[]) => { pulls.push(args); },
    stop: async () => { stopped = true; },
  } });
  try {
    await agent.apply({ commandId: null, target: null });
    assert.equal(pulls.length, 1);
    assert.deepEqual((pulls[0] as unknown[]).slice(0, 2), ["example/app", "latest"]);
    assert.equal(((pulls[0] as unknown[])[2] as { platform: string }).platform, "linux/arm64/v8");
    assert.equal(stopped, false);
    assert.equal(agent.status.failedDigest, null);
    assert.equal(agent.status.state, "failed");
    assert.match(JSON.stringify(agent.status.lastResult), /tag changed during download/);
  } finally { await agent.stop(); await h.close(); }
});

test("the app receives the switching phase before the first container is stopped", async () => {
  const h = await harness();
  h.clearCommand();
  const app = await h.options.docker.inspectContainer("app");
  assert.ok(app);
  const containers = new Map<string, Record<string, unknown>>([["app", structuredClone(app)]]);
  let stopped = false;
  const agent = createAgent({ ...h.options, docker: { ...h.options.docker,
    listDanglingImages: async () => [],
    inspectImage: async (ref: string) => ({ Id: ref === "example/app:latest" ? "new-image" : "image", Config: {}, RepoTags: ["example/app:latest"], RepoDigests: [`example/app@${digest}`] }),
    inspectContainer: async (id: string) => containers.get(id) ?? [...containers.values()].find((item) => item.Name === `/${id}`) ?? (id === hostname() ? h.options.docker.inspectContainer(id) : null),
    pull: async () => {},
    stop: async (id: string) => {
      assert.ok(h.reports.some((report) => report.state === "recreating"));
      containers.get(id)!.State = { Running: false };
      stopped = true;
    },
    rename: async (id: string, name: string) => { containers.get(id)!.Name = `/${name}`; },
    create: async (name: string, config: Record<string, unknown>) => {
      containers.set("new-app", { Id: "new-app", Name: `/${name}`, Image: "new-image", Config: { ...config, Healthcheck: { Test: ["CMD", "healthy"] } }, State: { Running: true, Status: "running", Health: { Status: "healthy" } } });
      return { Id: "new-app" };
    },
    start: async () => {},
    remove: async (id: string) => { containers.delete(id); },
  } });
  try {
    await agent.apply({ commandId: null, target: null });
    assert.equal(stopped, true);
    assert.equal(agent.status.state, "idle");
  } finally { await agent.stop(); await h.close(); }
});


test("failed updates persist bounded history and subsequent checks preserve it", async () => {
  const h = await harness();
  h.clearCommand();
  const agent = createAgent({ ...h.options, docker: { ...h.options.docker,
    listDanglingImages: async () => [],
    pull: async () => { throw new Error("download failed"); },
  } });
  try {
    for (let i = 0; i < 7; i += 1) await agent.apply({ commandId: `history-${i.toString().padStart(8, "0")}`, target: null });
    assert.equal(agent.status.history.length, 5);
    const saved = JSON.parse(await readFile(path.join(h.options.stateDir, "state.json"), "utf8"));
    assert.equal(saved.activeRun, null);
    assert.equal(saved.history[0].detail, "download failed");
    assert.deepEqual(saved.history[0].services, ["app"]);
    assert.ok(saved.history[0].phases.pulling >= 0);
    await agent.check();
    assert.deepEqual(agent.status.history, saved.history);
    const restarted = createAgent(h.options);
    try { await restarted.start(); await restarted.stop(); assert.deepEqual(restarted.status.history, saved.history); }
    finally { await restarted.stop(); }
  } finally { await agent.stop(); await h.close(); }
});

for (const cleanupFailure of [false, true]) test(`group updates preserve stopped services and remain discoverable; cleanup failure=${cleanupFailure}`, async () => {
  const h = await harness();
  h.clearCommand();
  const original = await h.options.docker.inspectContainer("app");
  assert.ok(original);
  const job = { ...structuredClone(original), Id: "job", Name: "/test-job", State: { Running: false },
    Config: { ...structuredClone(original.Config), Labels: { ...original.Config.Labels, "com.docker.compose.service": "job" } } };
  const containers = new Map<string, Record<string, unknown>>([["app", structuredClone(original)], ["job", job]]);
  const imageId = `sha256:${"c".repeat(64)}`;
  let failed = false;
  const starts: string[] = [];
  const agent = createAgent({ ...h.options, docker: { ...h.options.docker,
    listContainers: async () => [...containers.values()].map(({ Id }) => ({ Id })),
    listDanglingImages: async () => [],
    inspectImage: async (ref: string) => ({ Id: ref === "image" ? "image" : imageId, Config: {}, RepoDigests: [`example/app@${digest}`] }),
    inspectContainer: async (id: string) => containers.get(id) ?? [...containers.values()].find((item) => item.Name === `/${id}`) ?? (id === hostname() ? h.options.docker.inspectContainer(id) : null),
    pull: async () => {},
    stop: async (id: string) => { containers.get(id)!.State = { Running: false, Status: "exited" }; },
    rename: async (id: string, name: string) => { containers.get(id)!.Name = `/${name}`; },
    create: async (name: string, config: Record<string, unknown>) => {
      assert.equal(config.Image, imageId);
      const id = `new-${name}`;
      containers.set(id, { Id: id, Name: `/${name}`, Image: imageId, Config: { ...config, Healthcheck: { Test: ["CMD", "healthy"] } }, State: { Running: false, Status: "created" } });
      return { Id: id };
    },
    start: async (id: string) => {
      starts.push(id);
      containers.get(id)!.State = { Running: true, Status: "running", Health: { Status: "healthy" } };
    },
    remove: async (id: string) => {
      if (cleanupFailure && !failed) { failed = true; throw new Error("cleanup unavailable"); }
      containers.delete(id);
    },
  } });
  try {
    await agent.apply({ commandId: null, target: null });
    assert.equal((agent.status.lastResult as { outcome: string } | null)?.outcome, "updated");
    assert.equal(agent.status.failedDigest, null);
    assert.deepEqual(starts, ["new-test-app"]);
    assert.deepEqual((agent.status.history as { services: string[] }[])[0].services, ["app", "job"]);
    const discovered = await agent.check();
    assert.equal(discovered?.ref.tag, "latest");
    assert.deepEqual(discovered?.containers.map((c) => c.Id), ["new-test-app"]);
    assert.deepEqual(discovered?.stopped.map((c) => c.Id), ["new-test-job"]);
    assert.equal(containers.size, 2);
  } finally { await agent.stop(); await h.close(); }
});

test("manual recovery blocks discovery and all update work", async () => {
  const h = await harness();
  let listings = 0;
  h.options.docker.listContainers = async () => { listings += 1; return []; };
  await writeFile(path.join(h.options.stateDir, "transaction.json"), JSON.stringify({ invalid: true }));
  const agent = createAgent(h.options);
  try {
    await agent.start();
    await agent.tick();
    await agent.apply({ commandId: null, target: null });
    await agent.check();
    assert.equal(listings, 0);
    assert.equal(h.checks(), 0);
    assert.equal((agent.status.progress as { startup?: string } | null)?.startup, "manual_recovery");
    assert.deepEqual(JSON.parse(await readFile(path.join(h.options.stateDir, "transaction.json"), "utf8")), { invalid: true });
  } finally { await agent.stop(); await h.close(); }
});
