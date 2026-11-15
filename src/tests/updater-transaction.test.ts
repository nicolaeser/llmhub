import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recreateGroup, recoverGroup } from "../../scripts/updater/transaction.mjs";

type Container = {
  Id: string; Name: string; Image: string;
  State: { Running: boolean; Status: string; ExitCode: number };
  Config: { Labels: Record<string, string>; StopTimeout: number };
  HostConfig: object; Mounts: object[];
};

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "updater-transaction-"));
  const journalFile = join(directory, "transaction.json");
  const originals: Container[] = ["app", "keeper", "job"].map((service) => ({
    Id: `old-${service}`, Name: `/${service}`, Image: "old-image",
    State: { Running: service !== "job", Status: service === "job" ? "exited" : "running", ExitCode: 0 },
    Config: { StopTimeout: 330, Labels: { "com.docker.compose.project": "test", "com.docker.compose.service": service, "llmhub.updater.target": "true" } },
    HostConfig: {}, Mounts: [],
  }));
  const containers = new Map(originals.map((c) => [c.Id, structuredClone(c)]));
  const snapshots: { step: string; journal: string; containers: [string, Container][] }[] = [];
  const calls: string[] = [];
  let fail = "";
  const capture = async (step: string) => {
    calls.push(step);
    snapshots.push({ step, journal: await readFile(journalFile, "utf8"), containers: structuredClone([...containers]) });
    if (step === fail) throw new Error(`lost response: ${step}`);
  };
  const docker = {
    inspectImage: async () => ({ Config: {} }),
    inspectContainer: async (id: string) => containers.get(id) ?? [...containers.values()].find((c) => c.Name === `/${id}`) ?? null,
    stop: async (id: string, seconds: number) => {
      assert.equal(seconds, 30);
      containers.get(id)!.State = { Running: false, Status: "exited", ExitCode: 0 };
      await capture(`stop ${id}`);
    },
    rename: async (id: string, name: string) => { containers.get(id)!.Name = `/${name}`; await capture(`rename ${id}`); },
    create: async (name: string, body: Record<string, unknown>) => {
      const id = `new-${name}`;
      containers.set(id, { Id: id, Name: `/${name}`, Image: body.Image as string, Config: body as Container["Config"],
        State: { Running: false, Status: "created", ExitCode: 0 }, HostConfig: {}, Mounts: [] });
      await capture(`create ${id}`);
      return { Id: id };
    },
    start: async (id: string) => { containers.get(id)!.State = { Running: true, Status: "running", ExitCode: 0 }; await capture(`start ${id}`); },
    remove: async (id: string) => { containers.delete(id); await capture(`remove ${id}`); },
  };
  const options = { journalFile, imageRef: "app:latest", image: { Id: "new-image" }, waitOptions: { settleMs: 0, pollMs: 1, healthyTimeoutMs: 0 } };
  return { originals, containers, snapshots, calls, docker, options, journalFile, setFailure: (step: string) => { fail = step; },
    close: () => rm(directory, { recursive: true, force: true }) };
}

test("every destructive boundary recovers the entire group or finishes committed cleanup", async () => {
  const h = await harness();
  try {
    await recreateGroup(h.docker, h.originals, h.options);
    const snapshots = [...h.snapshots];
    assert.equal(snapshots.length, 13);
    for (const snapshot of snapshots) {
      h.containers.clear();
      for (const [id, container] of structuredClone(snapshot.containers)) h.containers.set(id, container);
      await writeFile(h.journalFile, snapshot.journal);
      const plan = JSON.parse(snapshot.journal);
      await recoverGroup(h.docker, "com.docker.compose.project=test", h.options);
      assert.equal(h.containers.size, 3, snapshot.step);
      for (const original of h.originals) {
        const id = plan.state === "committed" ? original.Id.replace("old-", "new-") : original.Id;
        const restored = h.containers.get(id);
        assert.equal(restored?.Name, original.Name, snapshot.step);
        assert.equal(restored?.State.Running, original.State.Running, snapshot.step);
      }
      assert.deepEqual(await recoverGroup(h.docker, "com.docker.compose.project=test", h.options), { recovered: false });
    }
  } finally { await h.close(); }
});

test("later service failure rolls all switched targets back in reverse order", async () => {
  const h = await harness();
  try {
    h.setFailure("start new-keeper");
    await assert.rejects(recreateGroup(h.docker, h.originals, h.options), { rolledBack: true });
    assert.deepEqual([...h.containers.keys()].sort(), h.originals.map((c) => c.Id).sort());
    assert.ok(h.calls.indexOf("remove new-keeper") < h.calls.indexOf("remove new-app"));
    assert.equal(h.containers.get("old-job")?.State.Running, false);
    assert.ok(!h.calls.includes("remove old-app"));
  } finally { await h.close(); }
});

test("recovery handles a journal saved immediately before the stop request", async () => {
  const h = await harness();
  try {
    await recreateGroup(h.docker, h.originals, h.options);
    const beforeStop = h.snapshots.find((snapshot) => snapshot.step === "stop old-app")!;
    h.containers.clear();
    for (const original of h.originals) h.containers.set(original.Id, structuredClone(original));
    await writeFile(h.journalFile, beforeStop.journal);
    await recoverGroup(h.docker, "com.docker.compose.project=test", h.options);
    for (const original of h.originals) {
      assert.equal(h.containers.get(original.Id)?.Name, original.Name);
      assert.equal(h.containers.get(original.Id)?.State.Running, original.State.Running);
    }
    assert.equal(h.containers.size, h.originals.length);
  } finally { await h.close(); }
});

test("journal project tampering and foreign name occupants cannot mutate containers", async () => {
  const h = await harness();
  try {
    await recreateGroup(h.docker, h.originals, h.options);
    const snapshot = h.snapshots.find((s) => s.step === "create new-app")!;
    for (const foreign of [false, true]) {
      h.containers.clear();
      for (const [id, container] of structuredClone(snapshot.containers)) h.containers.set(id, container);
      await writeFile(h.journalFile, snapshot.journal);
      if (foreign) h.containers.get("new-app")!.Config.Labels["com.docker.compose.project"] = "other";
      const before = h.calls.length;
      await assert.rejects(recoverGroup(h.docker, `com.docker.compose.project=${foreign ? "test" : "other"}`, h.options), { manualRecovery: true });
      assert.equal(h.calls.length, before);
    }
  } finally { await h.close(); }
});

test("manual migration recovery retains all originals and replacements across restart", async () => {
  const h = await harness();
  try {
    const options = { ...h.options, waitOptions: { ...h.options.waitOptions, onStartup: async () => {
      throw Object.assign(new Error("migration requires recovery"), { manualRecovery: true, startup: { state: "migration_failed" } });
    } } };
    await assert.rejects(recreateGroup(h.docker, h.originals, options), { manualRecovery: true });
    assert.equal(h.containers.has("old-app"), true);
    assert.equal(h.containers.has("new-app"), true);
    const before = h.calls.length;
    await assert.rejects(recoverGroup(h.docker, "com.docker.compose.project=test", h.options), { manualRecovery: true });
    assert.equal(h.calls.length, before);
  } finally { await h.close(); }
});

test("a healthy schema-changing app prevents rollback after another target fails", async () => {
  const h = await harness();
  const now = new Date().toISOString();
  try {
    h.setFailure("start new-keeper");
    const docker = { ...h.docker,
      inspectContainer: async (id: string) => {
        const info = await h.docker.inspectContainer(id);
        return info ? { ...info, State: { ...info.State, StartedAt: now } } : null;
      },
      readFile: async (id: string) => {
        if (id !== "new-app") throw Object.assign(new Error("legacy image"), { status: 404 });
        return JSON.stringify({ version: 1, bootId: "boot", state: "starting", schemaChanged: true,
          bootStartedAt: now, heartbeatAt: now, migrationStartedAt: now });
      },
    };
    await assert.rejects(recreateGroup(docker, h.originals, h.options), { manualRecovery: true });
    assert.ok(h.containers.has("new-app"));
    assert.ok(h.containers.has("new-keeper"));
    assert.ok(h.containers.has("old-app"));
    assert.ok(h.containers.has("old-keeper"));
    assert.ok(!h.calls.some((call) => call.startsWith("remove ")));
  } finally { await h.close(); }
});
