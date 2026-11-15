import assert from "node:assert/strict";
import test from "node:test";
import { createConfigFor, networkingFor } from "../../scripts/updater/container-config.mjs";
import { recreateContainer, recoverLeftovers, replaceStoppedContainers, waitHealthy } from "../../scripts/updater/recreate.mjs";

function harness(fail = "") {
  const old = { Id: "old", Name: "/app", Image: "old-image", State: { Running: true, Status: "running", ExitCode: 0 }, Config: { StopTimeout: 330 }, HostConfig: {}, Mounts: [] };
  const containers = new Map<string, typeof old>([[old.Id, structuredClone(old)]]);
  const calls: string[] = [];
  const docker = {
    inspectImage: async () => ({ Config: {} }),
    inspectContainer: async (id: string) => containers.get(id) ?? [...containers.values()].find((c) => c.Name === `/${id}`) ?? null,
    listContainers: async () => [...containers.values()].map((c) => ({ Id: c.Id, Names: [c.Name] })),
    stop: async (id: string, seconds: number) => {
      calls.push(`stop ${seconds}`);
      containers.get(id)!.State = { Running: false, Status: "exited", ExitCode: 0 };
      if (fail === "stop") throw new Error("stop response lost");
    },
    rename: async (id: string, name: string) => {
      containers.get(id)!.Name = `/${name}`;
      if (fail === "rename" && name.endsWith("-old")) throw new Error("rename response lost");
    },
    create: async (name: string) => {
      if (fail === "create-before") throw new Error("create failed");
      containers.set("new", { ...structuredClone(old), Id: "new", Name: `/${name}`, State: { Running: false, Status: "created", ExitCode: 0 } });
      if (fail === "create") throw new Error("create response lost");
      return { Id: "new" };
    },
    start: async (id: string) => {
      calls.push(`start ${id}`);
      containers.get(id)!.State = { Running: true, Status: "running", ExitCode: 0 };
    },
    remove: async (id: string) => {
      calls.push(`remove ${id}`);
      if (fail === "remove" && id === "new") throw new Error("remove failed");
      containers.delete(id);
    },
    logs: async () => "",
  };
  const options = { imageRef: "app:latest", image: { Id: "new-image" }, onPhase: async () => {}, waitOptions: { pollMs: 1, settleMs: 0, healthyTimeoutMs: 5 } };
  return { old, containers, calls, docker, options };
}

for (const failure of ["stop", "rename", "create"]) {
  test(`rollback reconciles a successful ${failure} with a lost Docker response`, async () => {
    const h = harness(failure);
    await assert.rejects(recreateContainer(h.docker, h.old, h.options), /response lost/);
    assert.equal(h.containers.size, 1);
    assert.equal(h.containers.get("old")?.Name, "/app");
    assert.equal(h.containers.get("old")?.State.Running, true);
  });
}

test("phase reporting errors cannot prevent rollback", async () => {
  const h = harness("create");
  await assert.rejects(recreateContainer(h.docker, h.old, { ...h.options, onPhase: async (phase: string) => {
    if (phase === "rolling_back") throw new Error("report failed");
  } }), /response lost/);
  assert.equal(h.containers.get("old")?.State.Running, true);
  assert.equal(h.containers.has("new"), false);
});

test("recreate caps updater downtime while preserving the configured stop budget", async () => {
  const h = harness();
  await recreateContainer(h.docker, h.old, h.options);
  assert.ok(h.calls.includes("stop 30"));
  assert.equal(h.containers.has("old"), false);
});

test("an unresolved backup is preserved before any stop", async () => {
  const h = harness();
  h.containers.set("backup", { ...h.old, Id: "backup", Name: "/app-llmhub-old" });
  await assert.rejects(recreateContainer(h.docker, h.old, h.options), /unresolved backup/);
  assert.equal(h.containers.size, 2);
  assert.deepEqual(h.calls, []);
});

test("a created but never running container cannot pass the settle window", async () => {
  await assert.rejects(waitHealthy({ inspectContainer: async () => ({ State: { Status: "created", Running: false } }) }, "new", { settleMs: 0, healthyTimeoutMs: 0 }), /did not start/);
});

test("recovery validates a running replacement before deleting its backup", async () => {
  const h = harness();
  h.containers.get("old")!.Name = "/app-llmhub-old";
  await h.docker.create("app");
  await h.docker.start("new");
  await recoverLeftovers(h.docker, "project=test", h.options.waitOptions);
  assert.equal(h.containers.has("old"), false);
  assert.equal(h.containers.get("new")?.State.Running, true);
});

test("recovery restores a failed replacement and keeps the backup when removal fails", async () => {
  for (const fail of ["", "remove"]) {
    const h = harness(fail);
    h.containers.get("old")!.Name = "/app-llmhub-old";
    await h.docker.create("app");
    h.containers.get("new")!.State = { Running: false, Status: "dead", ExitCode: 1 };
    await recoverLeftovers(h.docker, "project=test", h.options.waitOptions);
    assert.equal(h.containers.get("old")?.Name, fail ? "/app-llmhub-old" : "/app");
    assert.equal(h.containers.has("new"), Boolean(fail));
  }
});

for (const fail of ["create-before", "create", ""]) {
  test(`stopped-container replacement preserves the original on failure: ${fail || "success"}`, async () => {
    const h = harness(fail);
    h.old.State = { Running: false, Status: "exited", ExitCode: 0 };
    h.containers.set("old", structuredClone(h.old));
    const replaced = await replaceStoppedContainers(h.docker, [h.old], h.options);
    assert.equal(replaced.length, fail ? 0 : 1);
    assert.equal(h.containers.size, 1);
    assert.equal([...h.containers.values()][0].Name, "/app");
    assert.equal([...h.containers.values()][0].State.Running, false);
    assert.ok(!h.calls.some((call) => call.startsWith("start")));
  });
}

test("recovery never starts the backup of an intentionally stopped container", async () => {
  const h = harness();
  h.containers.get("old")!.Name = "/app-llmhub-stopped-old";
  h.containers.get("old")!.State.Running = false;
  await recoverLeftovers(h.docker, "project=test", h.options.waitOptions);
  assert.equal(h.containers.get("old")?.Name, "/app");
  assert.equal(h.containers.get("old")?.State.Running, false);
});

test("config keeps anonymous volumes, bind targets, and network gateway priorities", () => {
  const container = {
    Config: {},
    HostConfig: { Binds: ["/data"], PortBindings: { "3000/tcp": [{ HostPort: "3000" }] } },
    Mounts: [
      { Type: "volume", Name: "existing-data", Destination: "/data", RW: true },
      { Type: "volume", Name: "journal", Destination: "/login-journal", RW: false },
    ],
    NetworkSettings: { Networks: { internal: { GwPriority: 10, Aliases: ["app"] } } },
  };
  const body = createConfigFor(container, {}, { imageRef: "app:latest", imageId: "new" });
  assert.deepEqual(body.HostConfig.Mounts, [{ Type: "volume", Source: "journal", Target: "/login-journal", ReadOnly: true }]);
  assert.deepEqual(networkingFor(container).EndpointsConfig, { internal: { GwPriority: 10, Aliases: ["app"] } });
  assert.deepEqual(body.HostConfig.PortBindings, container.HostConfig.PortBindings);
  assert.deepEqual(body.HostConfig.Binds, ["existing-data:/data"]);
});

test("anonymous structured volume mounts reuse their existing data and options", () => {
  const container = {
    HostConfig: { Mounts: [{ Type: "volume", Target: "/data", VolumeOptions: { NoCopy: true } }] },
    Mounts: [{ Type: "volume", Name: "existing", Destination: "/data" }],
  };
  const body = createConfigFor(container, {}, { imageRef: "app:latest", imageId: "new" });
  assert.deepEqual(body.HostConfig.Mounts, [{ Type: "volume", Target: "/data", Source: "existing", VolumeOptions: { NoCopy: true } }]);
});

test("failed recovery start keeps the backup discoverable for the next updater restart", async () => {
  const h = harness();
  h.containers.get("old")!.Name = "/app-llmhub-old";
  h.containers.get("old")!.State.Running = false;
  await recoverLeftovers({ ...h.docker, start: async () => { throw new Error("port still occupied"); } }, "project=test", h.options.waitOptions);
  assert.equal(h.containers.get("old")?.Name, "/app-llmhub-old");
  await recoverLeftovers(h.docker, "project=test", h.options.waitOptions);
  assert.equal(h.containers.get("old")?.Name, "/app");
  assert.equal(h.containers.get("old")?.State.Running, true);
});

test("a stopped container with stale healthy status is not accepted", async () => {
  await assert.rejects(waitHealthy({ inspectContainer: async () => ({
    Config: { Healthcheck: { Test: ["CMD", "health"] } },
    State: { Status: "dead", Running: false, ExitCode: 1, Health: { Status: "healthy" } },
  }) }, "new", { healthyTimeoutMs: 0 }), /exit code 1/);
});

test("a failed stop that leaves the old container running cannot report a successful rollback", async () => {
  const h = harness();
  await assert.rejects(recreateContainer({ ...h.docker, stop: async () => { throw new Error("stop timed out"); } }, h.old, {
    ...h.options,
    waitOptions: { ...h.options.waitOptions, timeoutMs: 0 },
  }), (err: Error & { rolledBack?: boolean }) => err.rolledBack === false && /rollback did not complete/.test(err.message));
  assert.equal(h.containers.get("old")?.State.Running, true);
  assert.ok(!h.calls.includes("start old"));
});

test("fresh migration bypasses ordinary unhealthy and timeout failures", async () => {
  const now = new Date().toISOString();
  let reads = 0;
  const states: unknown[] = [];
  await waitHealthy({
    inspectContainer: async () => ({ State: { StartedAt: now, Running: true, Status: "running", Health: { Status: reads < 2 ? "unhealthy" : "healthy" } }, Config: { Healthcheck: { Test: ["CMD", "health"] } } }),
    readFile: async () => JSON.stringify({ version: 1, bootId: "boot", state: ++reads < 3 ? "migrating" : "starting", schemaChanged: false,
      bootStartedAt: now, heartbeatAt: now, migrationStartedAt: now }),
  }, "new", { pollMs: 1, healthyTimeoutMs: 0, onStartup: async (status: { state: string }) => { states.push(status.state); } });
  assert.deepEqual(states, ["migrating", "migrating", "starting"]);
});

test("schema-changing startup failure requires manual recovery", async () => {
  const now = new Date().toISOString();
  await assert.rejects(waitHealthy({
    inspectContainer: async () => ({ State: { StartedAt: now, Running: true, Status: "running", Health: { Status: "unhealthy" } }, Config: { Healthcheck: { Test: ["CMD", "health"] } } }),
    readFile: async () => JSON.stringify({ version: 1, bootId: "boot", state: "starting", schemaChanged: true,
      bootStartedAt: now, heartbeatAt: now, migrationStartedAt: now }),
  }, "new", { pollMs: 1, healthyTimeoutMs: 0 }), { manualRecovery: true });
});
