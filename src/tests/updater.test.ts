import assert from "node:assert/strict";
import { hostname } from "node:os";
import test from "node:test";
import { recordedPrisma } from "./support/recorded-prisma";
import { createConfigFor, hasHealthcheck, stopSeconds } from "../../scripts/updater/container-config.mjs";
import { createAgent, desiredOf } from "../../scripts/updater/agent.mjs";
import { untarFirstFile } from "../../scripts/updater/docker.mjs";
import { recreateContainer, replaceStoppedContainers, waitHealthy } from "../../scripts/updater/recreate.mjs";
import {
  digestsFor,
  isPinned,
  normalizeRepository,
  parseImageRef,
  updateAvailable,
} from "../../scripts/updater/image-ref.mjs";
import { signBody, updaterKey as scriptKey, verifySignature } from "../../scripts/updater/signature.mjs";
import type { StoredUpdaterStatus, UpdaterCommand, UpdaterReport, UpdaterSnapshot } from "@/types/updates";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const SHORT_ID = "abcdef123456";
const HEALTHCHECK = {
  Test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/internal-api/health')"],
  Interval: 30_000_000_000,
  Timeout: 5_000_000_000,
  StartPeriod: 60_000_000_000,
  Retries: 3,
};
const IMAGE_CMD = ["sh", "-c", "node migrate-deploy.mjs && exec node server.js"];

function oldImage() {
  return {
    Id: "sha256:old",
    Config: {
      Env: ["PATH=/usr/local/bin:/usr/bin", "NODE_ENV=production", "BUILD_ID=v2026.10.01.aaaaaaa"],
      Cmd: IMAGE_CMD,
      Entrypoint: null,
      WorkingDir: "/app",
      User: "node",
      Labels: { "org.opencontainers.image.title": "LLM Hub" },
      ExposedPorts: { "3000/tcp": {} },
      Healthcheck: HEALTHCHECK,
    },
  };
}

function appContainer(overrides: Record<string, unknown> = {}) {
  return {
    Id: `${SHORT_ID}${"0".repeat(52)}`,
    Name: "/llmhub-app-1",
    Image: "sha256:old",
    State: { Running: true },
    Config: {
      Hostname: SHORT_ID,
      Image: "ghcr.io/nicolaeser/llmhub:latest",
      Env: [
        "PATH=/usr/local/bin:/usr/bin",
        "NODE_ENV=production",
        "BUILD_ID=v2026.10.01.aaaaaaa",
        "DATABASE_URL=postgresql://hub@postgres:5432/hub",
        "LLMHUB_FEATURE=on",
      ],
      Cmd: IMAGE_CMD,
      Entrypoint: null,
      WorkingDir: "/app",
      User: "node",
      Labels: {
        "org.opencontainers.image.title": "LLM Hub",
        "com.docker.compose.project": "llmhub",
        "com.docker.compose.service": "app",
        "com.docker.compose.image": "sha256:old",
        "llmhub.updater.target": "true",
      },
      ExposedPorts: { "3000/tcp": {} },
      Healthcheck: HEALTHCHECK,
      ...overrides,
    },
    HostConfig: {
      NetworkMode: "llmhub_default",
      PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }] },
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Binds: ["/srv/llmhub/data:/data"],
    },
    NetworkSettings: {
      Networks: {
        llmhub_default: { Aliases: ["llmhub-app-1", "app", SHORT_ID], IPAMConfig: null, Links: null },
        backend: { Aliases: ["api"], IPAMConfig: { IPv4Address: "172.30.0.5" }, Links: ["db:database"] },
      },
    },
  };
}

test("recreate config drops every value that only came from the old image", () => {
  const body = createConfigFor(appContainer(), oldImage(), {
    imageRef: "ghcr.io/nicolaeser/llmhub:latest",
    imageId: "sha256:new",
  });
  assert.equal(body.Image, "ghcr.io/nicolaeser/llmhub:latest");
  assert.deepEqual(body.Env, ["DATABASE_URL=postgresql://hub@postgres:5432/hub", "LLMHUB_FEATURE=on"]);
  for (const key of ["Cmd", "Entrypoint", "WorkingDir", "User", "Healthcheck", "Hostname"]) {
    assert.equal(key in body, false, key);
  }
  assert.deepEqual(body.Labels, {
    "com.docker.compose.project": "llmhub",
    "com.docker.compose.service": "app",
    "com.docker.compose.image": "sha256:new",
    "llmhub.updater.target": "true",
  });
  assert.deepEqual(body.ExposedPorts, { "3000/tcp": {} });
  assert.deepEqual(body.HostConfig.RestartPolicy, { Name: "unless-stopped", MaximumRetryCount: 0 });
  assert.deepEqual(body.HostConfig.Binds, ["/srv/llmhub/data:/data"]);
  assert.deepEqual(body.NetworkingConfig, {
    EndpointsConfig: {
      llmhub_default: { Aliases: ["llmhub-app-1", "app"] },
      backend: { Aliases: ["api"], IPAMConfig: { IPv4Address: "172.30.0.5" }, Links: ["db:database"] },
    },
  });
});

test("recreate config keeps container overrides and replaces marker variables", () => {
  const body = createConfigFor(
    appContainer({
      Cmd: ["node", "updater.mjs"],
      User: "0:0",
      Healthcheck: { ...HEALTHCHECK, Test: ["CMD", "node", "updater.mjs", "--healthcheck"] },
      Env: ["PATH=/usr/local/bin:/usr/bin", "LLMHUB_UPDATER_PREDECESSOR=old", "APP_SECRET=kept"],
    }),
    oldImage(),
    { imageRef: "ghcr.io/nicolaeser/llmhub:latest", imageId: "sha256:new", env: ["LLMHUB_UPDATER_PREDECESSOR=current"] },
  );
  assert.deepEqual(body.Cmd, ["node", "updater.mjs"]);
  assert.equal(body.User, "0:0");
  assert.deepEqual(body.Healthcheck, { Test: ["CMD", "node", "updater.mjs", "--healthcheck"] });
  assert.deepEqual(body.Env, ["APP_SECRET=kept", "LLMHUB_UPDATER_PREDECESSOR=current"]);
  assert.equal(hasHealthcheck({ Config: { Healthcheck: { Test: ["NONE"] } } }), false);
  assert.equal(hasHealthcheck(appContainer()), true);
  assert.equal(stopSeconds(appContainer()), 330);
  assert.equal(stopSeconds({ Config: { StopTimeout: 45 } }), 45);
});

async function recreateRecorded(container: ReturnType<typeof appContainer>) {
  const calls: [string, ...unknown[]][] = [];
  const docker = {
    inspectImage: async () => oldImage(),
    inspectContainer: async (id: string) =>
      id === "sha256:created" ? { State: { Status: "running", Health: { Status: "healthy" } }, Config: { Healthcheck: HEALTHCHECK } } : null,
    stop: async (id: string, seconds: number) => void calls.push(["stop", id, seconds]),
    rename: async (id: string, name: string) => void calls.push(["rename", id, name]),
    create: async (name: string, body: { StopTimeout?: number }) => {
      calls.push(["create", name, body.StopTimeout]);
      return { Id: "sha256:created" };
    },
    start: async (id: string) => void calls.push(["start", id]),
    remove: async (id: string) => void calls.push(["remove", id]),
  };
  await recreateContainer(docker, container, {
    imageRef: "ghcr.io/nicolaeser/llmhub:latest",
    image: { Id: "sha256:new" },
    onPhase: async () => {},
    waitOptions: { pollMs: 1 },
  });
  return calls;
}

test("recreating a container gives open requests the grace period and keeps it on the new container", async () => {
  const container = appContainer();
  const calls = await recreateRecorded(container);
  assert.deepEqual(calls.find(([name]) => name === "stop"), ["stop", container.Id, 330]);
  assert.deepEqual(calls.find(([name]) => name === "create"), ["create", "llmhub-app-1", 330]);
  const tuned = await recreateRecorded(appContainer({ StopTimeout: 45 }));
  assert.deepEqual(tuned.find(([name]) => name === "stop")?.[2], 45);
  assert.deepEqual(tuned.find(([name]) => name === "create")?.[2], 45);
});

test("a recreated job that exits cleanly counts as started, a service that exits does not", async () => {
  const exited = (policy: string, exitCode = 0) => ({
    inspectContainer: async () => ({
      State: { Status: "exited", ExitCode: exitCode },
      RestartCount: 0,
      HostConfig: { RestartPolicy: { Name: policy, MaximumRetryCount: 5 } },
      Config: { Healthcheck: { Test: ["NONE"] } },
    }),
  });
  await waitHealthy(exited("on-failure"), "job", { pollMs: 1 });
  await waitHealthy(exited("no"), "job", { pollMs: 1 });
  await assert.rejects(waitHealthy(exited("on-failure", 1), "job", { pollMs: 1 }), /exit code 1/);
  await assert.rejects(waitHealthy(exited("unless-stopped"), "service", { pollMs: 1 }), /exit code 0/);
});

function labeledContainer(id: string, name: string, running: boolean, image = "sha256:old", ref = "ghcr.io/nicolaeser/llmhub:latest") {
  const container = appContainer({ Image: ref });
  return { ...container, Id: id, Name: `/${name}`, Image: image, State: { Running: running } };
}

test("the updater lists stopped labeled containers of its image next to the running targets and skips backups", async () => {
  const containers = [
    labeledContainer("app", "llmhub-app-1", true),
    labeledContainer("redactor", "llmhub-redactor-1", true),
    labeledContainer("fetch", "llmhub-redactor-fetch-1", false),
    labeledContainer("backup", "llmhub-app-1-llmhub-old", false),
    labeledContainer("other", "llmhub-tool-1", false, "sha256:other", "ghcr.io/nicolaeser/other:latest"),
  ];
  const self = { Id: hostname(), Name: "/llmhub-updater-1", Config: { Labels: { "com.docker.compose.project": "llmhub" } } };
  const listed: [string[], boolean][] = [];
  const docker = {
    listContainers: async (labels: string[], all: boolean) => {
      listed.push([labels, all]);
      return containers.map(({ Id }) => ({ Id }));
    },
    inspectContainer: async (id: string) => (id === self.Id ? self : containers.find((container) => container.Id === id) ?? null),
    inspectImage: async () => ({ RepoDigests: [`ghcr.io/nicolaeser/llmhub@${DIGEST_A}`] }),
    distribution: async () => ({ Descriptor: { digest: DIGEST_B } }),
  };
  const agent = createAgent({
    docker,
    key: scriptKey("x".repeat(32)),
    appUrl: new URL("http://127.0.0.1:9"),
    version: "test",
  });
  const target = await agent.check();
  assert.deepEqual(listed, [[["com.docker.compose.project=llmhub", "llmhub.updater.target=true"], true]]);
  assert.deepEqual(target?.containers.map((container) => container.Id), ["app", "redactor"]);
  assert.deepEqual(target?.stopped.map((container) => container.Id), ["fetch"]);
  assert.equal(agent.status.targets, 2);
  assert.equal(agent.status.available, true);
});

test("stopped labeled containers move to the new image without being started", async () => {
  const calls: [string, ...unknown[]][] = [];
  const docker = {
    inspectImage: async (id: string) => (id === "sha256:gone" ? null : oldImage()),
    remove: async (id: string) => void calls.push(["remove", id]),
    create: async (name: string, body: { Image: string; Labels: Record<string, string> }) => {
      calls.push(["create", name, body.Image, body.Labels["com.docker.compose.image"]]);
      return { Id: `sha256:${name}` };
    },
    start: async (id: string) => void calls.push(["start", id]),
  };
  const replaced = await replaceStoppedContainers(
    docker,
    [
      labeledContainer("fetch", "llmhub-redactor-fetch-1", false),
      labeledContainer("current", "llmhub-current-1", false, "sha256:new"),
      labeledContainer("orphan", "llmhub-orphan-1", false, "sha256:gone"),
    ],
    { imageRef: "ghcr.io/nicolaeser/llmhub:latest", image: { Id: "sha256:new" } },
  );
  assert.deepEqual(
    replaced.map((container) => container.Id),
    ["fetch"],
  );
  assert.deepEqual(calls, [
    ["remove", "fetch"],
    ["create", "llmhub-redactor-fetch-1", "ghcr.io/nicolaeser/llmhub:latest", "sha256:new"],
  ]);
});

test("image references, digests, and pinned tags are recognized", () => {
  assert.deepEqual(parseImageRef("ghcr.io/nicolaeser/llmhub:latest"), {
    name: "ghcr.io/nicolaeser/llmhub",
    tag: "latest",
    digest: null,
  });
  assert.deepEqual(parseImageRef("127.0.0.1:5000/llmhub"), { name: "127.0.0.1:5000/llmhub", tag: "latest", digest: null });
  assert.equal(parseImageRef(`ghcr.io/nicolaeser/llmhub@${DIGEST_A}`)?.digest, DIGEST_A);
  assert.equal(parseImageRef(DIGEST_A), null);
  for (const tag of ["latest", "dev", "development", "main"]) {
    assert.equal(isPinned(parseImageRef(`ghcr.io/nicolaeser/llmhub:${tag}`)), false, tag);
  }
  for (const tag of ["v2026.10.12.abc1234", "dev-2026.10.12.abc1234", "sha-abc1234", "dev-abc1234", "a".repeat(40)]) {
    assert.equal(isPinned(parseImageRef(`ghcr.io/nicolaeser/llmhub:${tag}`)), true, tag);
  }
  assert.equal(isPinned(parseImageRef(`ghcr.io/nicolaeser/llmhub@${DIGEST_A}`)), true);
  assert.equal(normalizeRepository("busybox"), "docker.io/library/busybox");
  assert.equal(normalizeRepository("docker.io/library/busybox"), "docker.io/library/busybox");
  assert.equal(normalizeRepository("localhost:5000/hub"), "localhost:5000/hub");
  assert.deepEqual(
    digestsFor([`ghcr.io/nicolaeser/llmhub@${DIGEST_A}`, `ghcr.io/other/llmhub@${DIGEST_B}`], "ghcr.io/nicolaeser/llmhub"),
    [DIGEST_A],
  );
  assert.deepEqual(digestsFor([`busybox@${DIGEST_B}`], "docker.io/library/busybox"), [DIGEST_B]);
  assert.deepEqual(digestsFor(null, "busybox"), []);
  assert.equal(updateAvailable(DIGEST_B, [DIGEST_A]), true);
  assert.equal(updateAvailable(DIGEST_A, [DIGEST_A]), false);
  assert.equal(updateAvailable(null, []), false);
});

test("the successor reads its predecessor's state file from a Docker archive", () => {
  const content = JSON.stringify({ failedDigest: DIGEST_A });
  const header = Buffer.alloc(512);
  header.write("llmhub-updater.state.json", 0, "ascii");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  const archive = Buffer.concat([header, Buffer.from(content), Buffer.alloc(1024)]);
  assert.equal(untarFirstFile(archive), content);
  assert.equal(untarFirstFile(Buffer.alloc(100)), null);
  assert.equal(untarFirstFile(Buffer.concat([header, Buffer.from("{")])), null);
});

test("the app and the updater derive the same key and accept each other's signatures", async () => {
  const { updaterKey } = await import("@/lib/crypto");
  const { signUpdaterBody, verifyUpdaterSignature } = await import("@/lib/updates/updater-signature");
  const appKey = updaterKey();
  const secret = process.env.APP_SECRET ?? "";
  assert.ok(appKey.equals(scriptKey(secret)));
  assert.equal(appKey.length, 32);
  const now = 1_760_000_000_000;
  const body = JSON.stringify({ state: "idle" });
  assert.equal(verifyUpdaterSignature(appKey, signBody(scriptKey(secret), body, now), body, now), "ok");
  assert.equal(verifySignature(scriptKey(secret), signUpdaterBody(appKey, body, now, "response"), body, now, "response"), "ok");
  assert.equal(verifyUpdaterSignature(appKey, signBody(scriptKey(secret), body, now), `${body} `, now), "invalid");
  assert.equal(verifyUpdaterSignature(appKey, signBody(scriptKey(secret), body, now - 61_000), body, now), "expired");
  assert.equal(verifyUpdaterSignature(appKey, signUpdaterBody(appKey, body, now, "response"), body, now), "invalid");
  assert.equal(verifyUpdaterSignature(appKey, signBody(scriptKey(`${secret}x`), body, now), body, now), "invalid");
  assert.equal(verifyUpdaterSignature(appKey, null, body, now), "missing");
  assert.equal(verifyUpdaterSignature(appKey, "t=abc,s=00", body, now), "invalid");
});

function report(overrides: Partial<UpdaterReport> = {}): UpdaterReport {
  return {
    version: "v2026.10.12.abc1234",
    state: "idle",
    issue: null,
    image: "ghcr.io/nicolaeser/llmhub",
    tag: "latest",
    pinned: false,
    targets: 1,
    currentDigest: DIGEST_A,
    latestDigest: DIGEST_B,
    available: true,
    checkedAt: "2026-10-19T10:00:00.000Z",
    failedDigest: null,
    lastResult: null,
    ackCommandId: null,
    ...overrides,
  };
}

function settingStore(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  recordedPrisma.reset({
    setting: {
      findMany: (args: { where: { key: { in: string[] } } }) =>
        args.where.key.in.flatMap((key) => (rows.has(key) ? [{ key, value: rows.get(key) }] : [])),
      upsert: (args: { where: { key: string }; update: { value: string } }) => {
        rows.set(args.where.key, args.update.value);
        return { key: args.where.key, value: args.update.value };
      },
      deleteMany: (args: { where: { key: string; value: string } }) => {
        const match = rows.get(args.where.key) === args.where.value;
        if (match) rows.delete(args.where.key);
        return { count: match ? 1 : 0 };
      },
    },
  });
  return rows;
}

async function postReport(body: string, header: string | null) {
  const { POST } = await import("@/app/internal-api/updater/route");
  const headers = new Headers({ "content-type": "application/json" });
  if (header) headers.set("x-llmhub-updater", header);
  return POST(new Request("http://localhost/internal-api/updater", { method: "POST", body, headers }));
}

test("the updater route rejects unsigned, forged, and stale reports before touching the database", async () => {
  settingStore();
  const key = scriptKey(process.env.APP_SECRET ?? "");
  const body = JSON.stringify(report());
  for (const header of [null, signBody(scriptKey("another-secret-0123456789abcdef0123"), body, Date.now()), signBody(key, body, Date.now() - 120_000)]) {
    const res = await postReport(body, header);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("content-type") ?? "", /^application\/problem\+json/);
    assert.equal((await res.json()).code, "UNAUTHORIZED");
  }
  assert.equal(recordedPrisma.calls.length, 0);
  const invalid = await postReport("{}", signBody(key, "{}", Date.now()));
  assert.equal(invalid.status, 422);
  assert.equal(recordedPrisma.calls.length, 0);
});

test("a signed report is stored and answered with the signed desired state, and an ack clears the command", async () => {
  const command: UpdaterCommand = {
    id: "0b1f6d1e-1d3c-4c55-9d5a-1d6a2c3b4e5f",
    action: "update",
    requestedAt: new Date().toISOString(),
    requestedBy: "user-1",
  };
  const rows = settingStore({
    enterprise: JSON.stringify({ auto_update: true }),
    updater_command: JSON.stringify(command),
  });
  const key = scriptKey(process.env.APP_SECRET ?? "");
  const first = JSON.stringify(report());
  const res = await postReport(first, signBody(key, first, Date.now()));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(verifySignature(key, res.headers.get("x-llmhub-updater"), text, Date.now(), "response"), "ok");
  assert.deepEqual(desiredOf(JSON.parse(text)), { auto: true, command: { id: command.id, action: "update" } });
  const stored = JSON.parse(rows.get("updater_status") ?? "{}") as StoredUpdaterStatus;
  assert.equal(stored.latestDigest, DIGEST_B);
  assert.ok(Date.now() - Date.parse(stored.seenAt) < 5_000);

  const acked = JSON.stringify(report({ state: "pulling", ackCommandId: command.id }));
  const next = await postReport(acked, signBody(key, acked, Date.now()));
  assert.deepEqual(await next.json(), { auto: true, command: null });
  assert.equal(rows.has("updater_command"), false);
});

test("updater views mark stale updaters as disconnected and expire old commands", async () => {
  const { commandActive, desiredState, isRestarting, livePayload, updaterView, UPDATER_COMMAND_TTL_MS } = await import(
    "@/lib/updates/updater-view"
  );
  const now = Date.parse("2026-10-19T10:00:00.000Z");
  const status: StoredUpdaterStatus = { ...report({ state: "recreating" }), seenAt: new Date(now - 10_000).toISOString() };
  const command: UpdaterCommand = { id: "command-0001", action: "check", requestedAt: new Date(now).toISOString(), requestedBy: "u" };
  const view = updaterView(status, command, false, now);
  assert.equal(view?.connected, true);
  assert.equal(view?.seenAt, null);
  assert.equal(updaterView(status, command, false, now + 25_000)?.seenAt, status.seenAt);
  assert.equal(view?.pending, "check");
  assert.equal(view?.available, true);
  assert.equal(updaterView(status, command, false, now + 25_000)?.connected, false);
  assert.equal(updaterView({ ...status, pinned: true }, null, false, now)?.available, false);
  assert.equal(updaterView(null, command, true, now), null);
  assert.equal(commandActive(command, now + UPDATER_COMMAND_TTL_MS), false);
  assert.deepEqual(desiredState(true, command, now + UPDATER_COMMAND_TTL_MS), { auto: true, command: null });
  assert.equal(isRestarting(status, now), true);
  assert.equal(isRestarting({ ...status, state: "idle" }, now), false);
  assert.equal(isRestarting(status, now + 16 * 60_000), false);

  const snapshot: UpdaterSnapshot = {
    build: { version: "v2026.10.12.abc1234", startedAt: "2026-10-19T09:00:00.000Z" },
    updater: view,
    updating: true,
  };
  assert.deepEqual(livePayload(snapshot, { canRead: false, canManage: true }), {
    build: snapshot.build,
    updater: null,
    updating: true,
    canRead: false,
    canManage: false,
  });
  assert.deepEqual(livePayload(snapshot, { canRead: true, canManage: true }), {
    build: snapshot.build,
    updater: view,
    updating: true,
    canRead: true,
    canManage: true,
  });
});

test("the browser derives its badge from the live link and parses only complete payloads", async () => {
  const { healthOf, liveStatusOf, UPDATING_GRACE_MS } = await import("@/lib/updates/build-change");
  const base = { updating: false, reachable: null, lostAt: null, now: 0 };
  assert.equal(healthOf({ ...base, link: "connecting" }), "connecting");
  assert.equal(healthOf({ ...base, link: "open" }), "live");
  assert.equal(healthOf({ ...base, link: "open", updating: true }), "updating");
  assert.equal(healthOf({ ...base, link: "lost", lostAt: 1, now: 2 }), "reconnecting");
  assert.equal(healthOf({ ...base, link: "lost", lostAt: 1, now: 2, reachable: false }), "down");
  assert.equal(healthOf({ ...base, link: "lost", lostAt: 1, now: 2, updating: true, reachable: false }), "updating");
  assert.equal(
    healthOf({ ...base, link: "lost", lostAt: 1, now: 2 + UPDATING_GRACE_MS, updating: true, reachable: false }),
    "down",
  );
  const build = { version: "v2026.10.12.abc1234", startedAt: "2026-10-19T09:00:00.000Z" };
  assert.deepEqual(liveStatusOf({ build, updater: null, updating: false, canRead: true, canManage: false }), {
    build,
    updater: null,
    updating: false,
    canRead: true,
    canManage: false,
  });
  for (const body of [null, {}, { build }, { build, updating: "no", canRead: true, canManage: true }]) {
    assert.equal(liveStatusOf(body), null, JSON.stringify(body));
  }
});

test("the live stream sends retry, status on change, pings, and closes on abort or lost access", async () => {
  const { liveAccess, liveStream, sseEvent } = await import("@/lib/updates/live-stream");
  const snapshot: UpdaterSnapshot = {
    build: { version: "v2026.10.12.abc1234", startedAt: "2026-10-19T09:00:00.000Z" },
    updater: null,
    updating: false,
  };
  const abort = new AbortController();
  const stream = liveStream({
    sessionId: "session-1",
    access: liveAccess(["settings:read"]),
    signal: abort.signal,
    heartbeatMs: 20,
    loadSnapshot: async () => snapshot,
    checkAccess: async () => liveAccess(["settings:read"]),
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: ping")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += decoder.decode(chunk.value);
  }
  assert.ok(text.startsWith("retry: 3000\n\n"));
  assert.ok(
    text.includes(
      sseEvent("status", JSON.stringify({ build: snapshot.build, updater: null, updating: false, canRead: true, canManage: false })),
    ),
  );
  assert.equal(text.split("event: status").length - 1, 1);
  abort.abort();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
  }

  const revoked = liveStream({
    sessionId: "session-2",
    access: liveAccess(["settings:read", "settings:manage"]),
    signal: new AbortController().signal,
    heartbeatMs: 20,
    accessCheckMs: 0,
    loadSnapshot: async () => snapshot,
    checkAccess: async () => null,
  });
  const revokedReader = revoked.getReader();
  let revokedText = "";
  for (;;) {
    const chunk = await revokedReader.read();
    if (chunk.done) break;
    revokedText += decoder.decode(chunk.value);
  }
  assert.ok(revokedText.includes("event: expired"));
});

test("open live streams end with a restart event when the server shuts down", async () => {
  const { liveAccess, liveStream } = await import("@/lib/updates/live-stream");
  const snapshot: UpdaterSnapshot = {
    build: { version: "v2026.10.12.abc1234", startedAt: "2026-10-19T09:00:00.000Z" },
    updater: null,
    updating: false,
  };
  const reader = liveStream({
    sessionId: "session-3",
    access: liveAccess([]),
    signal: new AbortController().signal,
    loadSnapshot: async () => snapshot,
  }).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: status")) text += decoder.decode((await reader.read()).value);
  process.emit("SIGTERM");
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  assert.ok(text.endsWith("event: restart\ndata: {}\n\n"));
  const { GET } = await import("@/app/internal-api/live/route");
  const refused = await GET(new Request("http://localhost/internal-api/live"));
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("connection"), "close");
});
