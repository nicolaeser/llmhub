import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { boundedHistory, createAgent } from "../../scripts/updater/agent.mjs";
import { updaterReportSchema, UPDATER_BODY_LIMIT } from "@/schemas/updater";
import { updaterView } from "@/lib/updates/updater-view";

const at = new Date().toISOString();
const entry = { id: "history-12345", startedAt: at, finishedAt: at, outcome: "failed", detail: "failure", services: ["app"], phases: { checking: 10, pulling: 20, recreating: 30, verifying: 40, rolling_back: 50 } };

test("history is bounded, schema compatible, and fits the older signed bridge", () => {
  const history = boundedHistory(Array.from({ length: 100 }, (_, index) => ({ ...entry, id: `history-${index.toString().padStart(8, "0")}`, detail: "😀\n".repeat(500), services: Array.from({ length: 100 }, (_, i) => `${i}${"😀".repeat(100)}`) })));
  const agent = createAgent({ docker: {}, key: Buffer.alloc(32), appUrl: new URL("http://127.0.0.1:1"), version: "test" });
  const report = { version: "test", ...agent.status, history };
  assert.equal(history.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < UPDATER_BODY_LIMIT);
  const parsed = updaterReportSchema.parse(report);
  assert.deepEqual(updaterView({ ...parsed, seenAt: at }, null, false, Date.now())?.history, history);
  assert.equal(updaterReportSchema.safeParse({ ...report, history: undefined }).success, true);
});

test("update history survives restart and checks do not replace it", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "updater-history-"));
  const options = { docker: { inspectContainer: async () => null }, key: Buffer.alloc(32), appUrl: new URL("http://127.0.0.1:1"), version: "test", stateDir };
  await writeFile(path.join(stateDir, "state.json"), JSON.stringify({ history: [entry] }));
  const agent = createAgent(options);
  try {
    await agent.start();
    await agent.check();
    assert.deepEqual(agent.status.history, [entry]);
    assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8")).history, [entry]);
  } finally { await agent.stop(); await rm(stateDir, { recursive: true, force: true }); }
});
