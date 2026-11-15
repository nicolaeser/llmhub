import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { clearTimeout } from "node:timers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dockerClient } from "./updater/docker.mjs";
import { createAgent } from "./updater/agent.mjs";
import { waitHealthy, replaceStoppedContainers } from "./updater/recreate.mjs";
import { responseDroppingProxy } from "./updater-test/proxy.mjs";

const execute = promisify(execFile);
const ownerKey = "llmhub.updater.integration";
const owner = `updater-it-${randomUUID()}`;
const ownership = `${ownerKey}=${owner}`;
const socket = "/var/run/docker.sock";
const docker = dockerClient(socket);
const temporary = await mkdtemp(path.join(os.tmpdir(), "updater-it-"));
const fixtures = fileURLToPath(new URL("./updater-test/", import.meta.url));
const waitOptions = { healthyTimeoutMs: 20_000, settleMs: 100, pollMs: 100, timeoutMs: 5000 };
const images = {};
const results = [];
let transaction;
let child;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true;
    process.exitCode = 130;
    console.error("Stopping after the active fixture operation, then removing owned resources.");
  });
}

async function cli(...args) {
  const result = await execute("docker", ["--host", `unix://${socket}`, ...args], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}

async function ownedContainer(id) {
  const info = await docker.inspectContainer(id);
  assert.equal(info?.Config?.Labels?.[ownerKey], owner, `refusing mutation of unowned container ${id}`);
  return info;
}

function guarded(client) {
  const wrapped = { ...client };
  for (const method of ["stop", "start", "rename", "remove"]) {
    wrapped[method] = async (id, ...args) => {
      await ownedContainer(id);
      return client[method](id, ...args);
    };
  }
  wrapped.create = async (name, body) => {
    const image = await docker.inspectImage(body.Image);
    assert.equal(body.Labels?.[ownerKey] ?? image?.Config?.Labels?.[ownerKey], owner);
    assert.ok(name.startsWith(owner));
    return client.create(name, body);
  };
  wrapped.removeImage = async () => { throw new Error("image removal is forbidden during fixture updates"); };
  wrapped.listDanglingImages = async () => [];
  return wrapped;
}

async function setup(name, services = ["app", "keeper", "stopped"]) {
  const project = `${owner}-${name}`;
  const network = `${project}-network`;
  await cli("network", "create", "--internal", "--label", ownership, network);
  const volume = `${project}-data`;
  await cli("volume", "create", "--label", ownership, volume);
  const containers = [];
  for (const service of services) {
    const created = await docker.create(`${project}-${service}`, {
      Image: images.old.ref,
      Env: [`FIXTURE_SERVICE=${service}`, `FIXTURE_TOKEN=${project}`],
      Labels: { [ownerKey]: owner, "com.docker.compose.project": project, "com.docker.compose.service": service, "llmhub.updater.target": "true" },
      StopTimeout: 2,
      HostConfig: {
        NetworkMode: network,
        Memory: 96 * 1024 ** 2,
        Mounts: [
          { Type: "volume", Source: volume, Target: "/data" },
          { Type: "volume", Target: "/journal", VolumeOptions: { Labels: { [ownerKey]: owner } } },
        ],
      },
      NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [service] } } },
    });
    if (service !== "stopped") {
      await docker.start(created.Id);
      await waitHealthy(docker, created.Id, waitOptions);
    }
    containers.push(await docker.inspectContainer(created.Id));
  }
  return { project, network, containers, running: containers.filter((entry) => entry.State.Running), stopped: containers.filter((entry) => !entry.State.Running), journalFile: path.join(temporary, `${name}.json`) };
}

function options(group, image = images.good) {
  return { imageRef: image.ref, image, journalFile: group.journalFile, waitOptions, onPhase: async () => {} };
}

async function verify(group, image, original = false) {
  for (const old of group.containers) {
    const current = await docker.inspectContainer(old.Name.slice(1));
    assert.ok(current, `missing ${old.Name}`);
    assert.equal(current.Image, image.Id);
    assert.equal(current.State.Running, old.State.Running);
    if (original) assert.equal(current.Id, old.Id);
    for (const mount of old.Mounts) {
      assert.equal(current.Mounts.find((entry) => entry.Destination === mount.Destination)?.Name, mount.Name);
      if (old.State.Running) assert.equal(await docker.readFile(current.Id, `${mount.Destination}/sentinel`), group.project);
    }
    const service = old.Config.Labels["com.docker.compose.service"];
    assert.ok(current.NetworkSettings.Networks[group.network].Aliases.includes(service));
    if (old.State.Running) await waitHealthy(docker, current.Id, waitOptions);
  }
  assert.equal((await docker.listContainers([`com.docker.compose.project=${group.project}`], true)).length, group.containers.length);
}

async function run(name, test) {
  if (interrupted) throw new Error("fixture run interrupted");
  const started = Date.now();
  try {
    await test();
    results.push({ name, outcome: "passed", durationMs: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    await stopWorker();
    results.push({ name, outcome: "failed", error: error.stack, durationMs: Date.now() - started });
    console.error(`FAIL ${name}: ${error.stack}`);
    process.exitCode = 1;
  } finally {
    await cleanupResources(["volume", "network"]);
  }
}

async function recover(group) {
  await transaction.recoverGroup(guarded(docker), `com.docker.compose.project=${group.project}`, {
    journalFile: group.journalFile, onPhase: async () => {}, waitOptions,
  });
}

async function stopWorker() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  child = null;
}

async function cleanupResources(kinds) {
  await stopWorker();
  for (const info of await docker.listContainers([ownership], true)) {
    await ownedContainer(info.Id);
    await docker.remove(info.Id);
  }
  for (const kind of kinds) {
    const ids = (await cli(kind, "ls", "--filter", `label=${ownership}`, "--quiet")).split("\n").filter(Boolean);
    for (const id of new Set(ids)) {
      const [info] = JSON.parse(await cli(kind, "inspect", id));
      assert.equal((kind === "image" ? info.Config.Labels : info.Labels)?.[ownerKey], owner);
      await cli(kind, "rm", id);
    }
    assert.equal(await cli(kind, "ls", "--filter", `label=${ownership}`, "--quiet"), "");
  }
  assert.equal((await docker.listContainers([ownership], true)).length, 0);
}

async function cleanup() {
  await cleanupResources(["volume", "network", "image"]);
  await rm(temporary, { recursive: true, force: true });
}

try {
  console.log(`Fixture ownership: ${ownership}`);
  console.log(`Docker server: ${await cli("version", "--format", "{{.Server.Version}}")}`);
  for (const [name, failure] of [["old", "none"], ["good", "none"], ["bad", "keeper"]]) {
    if (interrupted) throw new Error("fixture build interrupted");
    const ref = `${owner}:${name}`;
    await cli("build", "--pull=false", "--network=none", "--label", ownership, "--build-arg", `FIXTURE_VERSION=${name}`, "--build-arg", `FIXTURE_FAILURE=${failure}`, "--tag", ref, fixtures);
    images[name] = { ...await docker.inspectImage(ref), ref };
  }
  await run("low disk refuses before pull or stop (injected measurement, real containers)", async () => {
    const group = await setup("disk", ["app"]);
    const stateDir = path.join(temporary, "disk-state");
    await mkdir(stateDir);
    let pullCalls = 0;
    let stopCalls = 0;
    const client = guarded(docker);
    client.pull = async () => { pullCalls += 1; throw new Error("must not pull"); };
    client.stop = async () => { stopCalls += 1; throw new Error("must not stop"); };
    const agent = createAgent({ docker: client, key: "fixture-only-secret", appUrl: new URL("http://127.0.0.1:1"), projectOverride: group.project, version: "fixture", stateDir, diskSpace: async () => ({ freeBytes: 1, totalBytes: 10 * 1024 ** 3 }) });
    try {
      await agent.apply({ commandId: null, target: { ref: { name: owner, tag: "good" }, containers: group.running, stopped: [] } });
      assert.equal(agent.status.lastResult.outcome, "failed");
      assert.match(agent.status.lastResult.detail, /free|disk/i);
      assert.equal(agent.status.failedDigest, null);
      assert.equal(pullCalls, 0);
      assert.equal(stopCalls, 0);
      await verify(group, images.old, true);
    } finally {
      await agent.stop();
    }
  });
  transaction = await import("./updater/transaction.mjs");
  assert.equal(typeof transaction.recreateGroup, "function");
  assert.equal(typeof transaction.recoverGroup, "function");
  await run("healthy group update preserves volumes, aliases and stopped services", async () => {
    const group = await setup("healthy");
    await transaction.recreateGroup(guarded(docker), group.running, options(group));
    await replaceStoppedContainers(guarded(docker), group.stopped, options(group));
    await verify(group, images.good);
  });
  await run("legacy single app with anonymous journal and no separate keeper", async () => {
    const group = await setup("legacy", ["app"]);
    assert.equal(group.running[0].HostConfig.Mounts.find((mount) => mount.Target === "/journal").Source, undefined);
    await transaction.recreateGroup(guarded(docker), group.running, options(group));
    await verify(group, images.good);
  });
  await run("unhealthy second service restores the entire old group", async () => {
    const group = await setup("unhealthy");
    let firstServiceUpdated = false;
    const updateOptions = options(group, images.bad);
    updateOptions.onPhase = async (phase, progress) => {
      if (phase === "verifying" && progress?.service === "keeper") {
        const app = await docker.inspectContainer(`${group.project}-app`);
        firstServiceUpdated = app?.Image === images.bad.Id && app?.State?.Health?.Status === "healthy";
      }
    };
    await assert.rejects(transaction.recreateGroup(guarded(docker), group.running, updateOptions), /unhealthy/i);
    assert.equal(firstServiceUpdated, true);
    await verify(group, images.old, true);
  });
  await run("unavailable fixture Docker socket leaves the group intact", async () => {
    const group = await setup("offline", ["app"]);
    await assert.rejects(transaction.recreateGroup(dockerClient(path.join(temporary, "offline.sock")), group.running, options(group)));
    await verify(group, images.old, true);
  });
  for (const operation of ["stop", "rename", "create", "start"]) {
    await run(`SIGKILL after real ${operation}, then durable recovery`, async () => {
      const group = await setup(`crash-${operation}`);
      const settingsFile = path.join(temporary, `worker-${operation}.json`);
      await writeFile(settingsFile, JSON.stringify({ socket, interruptAfter: operation, containers: group.running, options: options(group) }));
      child = fork(path.join(fixtures, "worker.mjs"), [settingsFile], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      const worker = child;
      const interrupted = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("worker did not reach interruption point")), 30_000);
        worker.once("message", (message) => { clearTimeout(timeout); resolve(message); });
        worker.once("exit", (code, signal) => { clearTimeout(timeout); reject(new Error(`worker exited early: ${code}/${signal}`)); });
        worker.once("error", reject);
      });
      assert.equal(interrupted.interrupted, operation);
      const exited = once(worker, "exit");
      worker.kill("SIGKILL");
      const [, signal] = await exited;
      child = null;
      assert.equal(signal, "SIGKILL");
      await recover(group);
      await verify(group, images.old, true);
      await recover(group);
      await verify(group, images.old, true);
    });
    await run(`lost Docker ${operation} response reconciles actual daemon state`, async () => {
      const group = await setup(`lost-${operation}`);
      const proxySocket = path.join(temporary, `${operation}.sock`);
      const proxy = await responseDroppingProxy(proxySocket, socket, operation);
      try {
        await assert.rejects(transaction.recreateGroup(guarded(dockerClient(proxySocket)), group.running, options(group)));
        assert.equal(proxy.dropped(), true);
      } finally {
        await proxy.close();
      }
      await recover(group);
      await verify(group, images.old, true);
    });
  }
} catch (error) {
  console.error(error.stack);
  results.push({ name: "harness integration", outcome: "failed", error: error.message });
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    console.error(`Cleanup failed for ${ownership}: ${error.stack}`);
    process.exitCode = 1;
  });
  console.log(JSON.stringify({ ownership, results }, null, 2));
}
