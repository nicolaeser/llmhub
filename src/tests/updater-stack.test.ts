import assert from "node:assert/strict";
import test from "node:test";
import { BACKUP_SUFFIX } from "../../scripts/updater/recreate.mjs";
import { REDIS_SNAPSHOT_FLAGS, snapshotRedisCommand, switchRedisToSnapshots } from "../../scripts/updater/stack.mjs";

function redis(id = "redis-original") {
  return {
    Id: id,
    Name: `/project-${id}`,
    Image: "sha256:original",
    Config: {
      Image: "redis:8-alpine",
      WorkingDir: "/data",
      Cmd: ["redis-server", "--appendonly", "yes", "--requirepass", "test-password"],
      Entrypoint: ["docker-entrypoint.sh"],
      Labels: { "com.docker.compose.project": "project", "com.docker.compose.service": "redis" },
      Healthcheck: { Test: ["CMD", "redis-cli", "ping"] },
    },
    State: { Running: true, Paused: false, Restarting: false, Status: "running", ExitCode: 0, Health: { Status: "healthy" } },
    HostConfig: { Binds: ["/data/redis:/data:rw"], RestartPolicy: { Name: "unless-stopped" } },
    Mounts: [{ Type: "bind", Source: "/data/redis", Name: "", Destination: "/data", RW: true }],
    NetworkSettings: { Networks: { project_default: { Aliases: ["redis"] } } },
  };
}

function harness(initial = [redis()], options: { backup?: boolean; stopExitCode?: number; unhealthy?: boolean; inspectFailure?: string } = {}) {
  const containers = new Map(initial.map((container) => [container.Id, structuredClone(container)]));
  const mutations: [string, string][] = [];
  const bodies: Record<string, unknown>[] = [];
  const docker = {
    listContainers: async (labels: string[]) => {
      assert.deepEqual(labels, ["com.docker.compose.project=project", "com.docker.compose.service=redis"]);
      return initial.map(({ Id }) => ({ Id }));
    },
    inspectContainer: async (id: string) => {
      if (id === options.inspectFailure) throw new Error("inspection unavailable");
      if (options.backup && id.endsWith(BACKUP_SUFFIX)) return { ...redis("backup"), Name: `/${id}` };
      return structuredClone(containers.get(id) ?? [...containers.values()].find((container) => container.Name === `/${id}`) ?? null);
    },
    inspectImage: async (id: string) => ({ Id: id === "redis:8-alpine" ? "sha256:different-tag-image" : id, Config: {} }),
    stop: async (id: string) => {
      mutations.push(["stop", id]);
      const container = containers.get(id)!;
      container.State.Running = false;
      container.State.Status = "exited";
      container.State.ExitCode = options.stopExitCode ?? 0;
    },
    rename: async (id: string, name: string) => {
      mutations.push(["rename", id]);
      containers.get(id)!.Name = `/${name}`;
    },
    create: async (name: string, body: Record<string, unknown>) => {
      mutations.push(["create", name]);
      bodies.push(body);
      const container = redis("replacement");
      container.Name = `/${name}`;
      container.State.Health.Status = options.unhealthy ? "unhealthy" : "healthy";
      containers.set(container.Id, container);
      return { Id: container.Id };
    },
    start: async (id: string) => {
      mutations.push(["start", id]);
      containers.get(id)!.State.Running = true;
    },
    remove: async (id: string) => {
      mutations.push(["remove", id]);
      containers.delete(id);
    },
    logs: async () => "",
  };
  return { docker, mutations, bodies, containers };
}

const waitOptions = { pollMs: 1, settleMs: 0, healthyTimeoutMs: 10 };

test("Redis persistence migration uses the original image even when its tag moved", async () => {
  const { docker, bodies, mutations } = harness();
  assert.deepEqual(await switchRedisToSnapshots(docker, "project", { waitOptions }), ["project-redis-original"]);
  assert.equal(bodies[0].Image, "sha256:original");
  assert.deepEqual(bodies[0].Cmd, ["redis-server", ...REDIS_SNAPSHOT_FLAGS, "--requirepass", "test-password"]);
  assert.deepEqual(bodies[0].HostConfig, redis().HostConfig);
  assert.deepEqual(bodies[0].NetworkingConfig, { EndpointsConfig: { project_default: { Aliases: ["redis"] } } });
  assert.equal("StopTimeout" in bodies[0], false);
  assert.deepEqual(mutations.at(-1), ["remove", "redis-original"]);
});

test("Redis migration preserves legacy anonymous data volumes", async () => {
  const container = redis();
  container.HostConfig.Binds = [];
  container.Mounts = [{ Type: "volume", Source: "/volumes/data", Name: "anonymous-data", Destination: "/data", RW: true }];
  const { docker, bodies } = harness([container]);
  await switchRedisToSnapshots(docker, "project", { waitOptions });
  assert.deepEqual((bodies[0].HostConfig as { Mounts: unknown }).Mounts, [
    { Type: "volume", Source: "anonymous-data", Target: "/data", ReadOnly: false },
  ]);
});

test("Redis migration never touches backups, stopped services, foreign projects or customized persistence", async (t) => {
  const cases: [string, (container: ReturnType<typeof redis>) => void][] = [
    ["backup", (container) => { container.Name += BACKUP_SUFFIX; }],
    ["stopped", (container) => { container.State.Running = false; }],
    ["paused", (container) => { container.State.Paused = true; }],
    ["restarting", (container) => { container.State.Restarting = true; }],
    ["unhealthy", (container) => { container.State.Health.Status = "unhealthy"; }],
    ["other project", (container) => { container.Config.Labels["com.docker.compose.project"] = "other"; }],
    ["other service", (container) => { container.Config.Labels["com.docker.compose.service"] = "postgres"; }],
    ["other image", (container) => { container.Config.Image = "example/redis:8"; }],
    ["custom flags", (container) => { container.Config.Cmd.push("--dir", "/custom"); }],
    ["custom directory", (container) => { container.Config.WorkingDir = "/custom"; }],
    ["unmounted data", (container) => { container.Mounts = []; }],
    ["readonly data", (container) => { container.Mounts[0].RW = false; }],
    ["temporary data", (container) => { container.Mounts[0].Type = "tmpfs"; }],
  ];
  for (const [name, customize] of cases) await t.test(name, async () => {
    const container = redis();
    customize(container);
    const { docker, mutations } = harness([container]);
    assert.deepEqual(await switchRedisToSnapshots(docker, "project", { waitOptions }), []);
    assert.deepEqual(mutations, []);
  });
});

test("an unresolved Redis backup prevents all destructive operations", async () => {
  const { docker, mutations } = harness([redis()], { backup: true });
  const skip = new Set<string>();
  assert.deepEqual(await switchRedisToSnapshots(docker, "project", { waitOptions, skip }), []);
  assert.deepEqual(mutations, []);
  assert.ok(skip.has("redis-original"));
});

test("one Redis inspection failure does not prevent maintenance of other candidates", async () => {
  const { docker, mutations } = harness([redis("unavailable"), redis()], { inspectFailure: "unavailable" });
  const skip = new Set<string>();
  assert.deepEqual(await switchRedisToSnapshots(docker, "project", { waitOptions, skip }), ["project-redis-original"]);
  assert.ok(skip.has("unavailable"));
  assert.ok(mutations.every(([, id]) => id !== "unavailable"));
});

test("failed final snapshot restores append-only Redis without creating a replacement", async () => {
  const { docker, mutations, bodies, containers } = harness([redis()], { stopExitCode: 137 });
  assert.deepEqual(await switchRedisToSnapshots(docker, "project", { waitOptions }), []);
  assert.deepEqual(mutations, [["stop", "redis-original"], ["start", "redis-original"]]);
  assert.deepEqual(bodies, []);
  assert.equal(containers.get("redis-original")?.State.Running, true);
});

test("unhealthy snapshot Redis rolls back and is not retried in the same updater lifetime", async () => {
  const { docker, mutations, containers } = harness([redis()], { unhealthy: true });
  const skip = new Set<string>();
  assert.deepEqual(await switchRedisToSnapshots(docker, "project", { waitOptions, skip }), []);
  assert.equal(containers.get("redis-original")?.Name, "/project-redis-original");
  assert.equal(containers.get("redis-original")?.State.Running, true);
  assert.equal(containers.has("replacement"), false);
  const count = mutations.length;
  await switchRedisToSnapshots(docker, "project", { waitOptions, skip });
  assert.equal(mutations.length, count);
});

test("empty stacks create no services and malformed command values are ignored", async () => {
  const { docker, mutations } = harness([]);
  assert.deepEqual(await switchRedisToSnapshots(docker, "project"), []);
  assert.deepEqual(mutations, []);
  assert.equal(snapshotRedisCommand(["redis-server", "--appendonly", "yes", "--requirepass", null]), null);
});
