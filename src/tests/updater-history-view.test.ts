import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadPercent,
  downloadView,
  durationParts,
  elapsedMilliseconds,
  phasePercent,
  recentUpdateRuns,
  runProgress,
  runSteps,
  stopwatch,
  summaryNotable,
  updaterSummary,
} from "../app/(app)/_components/updater-history-view";
import { finishedRunChime } from "../lib/updates/update-chime";

test("history selects five newest distinct runs without mutating the producer snapshot", () => {
  const runs = Array.from({ length: 7 }, (_, index) => ({ id: String(index), finishedAt: `2026-11-15T00:00:0${index}Z` }));
  const snapshot = structuredClone(runs);
  assert.deepEqual(recentUpdateRuns([...runs, runs[6]]).map((run) => run.id), ["6", "5", "4", "3", "2"]);
  assert.deepEqual(runs, snapshot);
  assert.deepEqual(recentUpdateRuns(), []);
});

test("durations retain subsecond precision and reject negative or invalid intervals", () => {
  assert.equal(elapsedMilliseconds("2026-11-15T00:00:00Z", "2026-11-15T00:00:01.234Z"), 1234);
  assert.equal(elapsedMilliseconds("2026-11-15T00:00:02Z", "2026-11-15T00:00:01Z"), 0);
  assert.equal(elapsedMilliseconds("invalid", Date.now()), 0);
});

test("unknown or inconsistent download totals never become a known total", () => {
  for (const totalBytes of [null, 0, -1, 10, Infinity, NaN]) {
    assert.equal(downloadView({ downloadedBytes: 20, totalBytes, layersCompleted: 1, layersTotal: 2 }).totalBytes, null);
  }
  assert.equal(downloadView({ downloadedBytes: 20, totalBytes: 40, layersCompleted: 1, layersTotal: 2 }).totalBytes, 40);
});

test("cached layers can finish with zero bytes and invalid counts stay bounded", () => {
  assert.deepEqual(downloadView({ downloadedBytes: 0, totalBytes: 0, layersCompleted: 4, layersTotal: 4 }), {
    downloadedBytes: 0, totalBytes: null, layersCompleted: 4, layersTotal: 4,
  });
  assert.deepEqual(downloadView({ downloadedBytes: NaN, totalBytes: null, layersCompleted: 9, layersTotal: 3 }), {
    downloadedBytes: 0, totalBytes: null, layersCompleted: 3, layersTotal: 3,
  });
});

const NOW = Date.parse("2026-11-16T12:00:00Z");
const progress = { startedAt: "2026-11-16T11:59:00Z", phaseStartedAt: "2026-11-16T11:59:30Z", service: null, completed: 0, total: 2 };
const idle = {
  connected: true,
  state: "idle" as const,
  progress: null,
  pending: null,
  pinned: false,
  available: false,
  lastResult: null,
};

test("download percent prefers bytes, falls back to layers, and stays unknown without either", () => {
  assert.equal(downloadPercent(downloadView({ downloadedBytes: 25, totalBytes: 100, layersCompleted: 0, layersTotal: 4 })), 25);
  assert.equal(downloadPercent(downloadView({ downloadedBytes: 25, totalBytes: null, layersCompleted: 3, layersTotal: 4 })), 75);
  assert.equal(downloadPercent(downloadView({ downloadedBytes: 25, totalBytes: null, layersCompleted: 0, layersTotal: 0 })), null);
});

test("phase percent follows the download, then the replaced services, and ignores idle reports", () => {
  const download = { downloadedBytes: 1, totalBytes: 3, layersCompleted: 0, layersTotal: 1 };
  assert.equal(phasePercent({ state: "pulling", progress: { ...progress, download } }), 33);
  assert.equal(phasePercent({ state: "verifying", progress: { ...progress, completed: 1 } }), 50);
  assert.equal(phasePercent({ state: "checking", progress }), null);
  assert.equal(phasePercent({ state: "idle", progress: { ...progress, download } }), null);
});

test("run steps mark earlier phases done and swap the tail for a rollback", () => {
  assert.deepEqual(runSteps("recreating").map((step) => step.state), ["done", "done", "active", "waiting"]);
  assert.deepEqual(runSteps("rolling_back").map((step) => [step.phase, step.state]), [
    ["checking", "done"], ["pulling", "done"], ["rolling_back", "active"],
  ]);
  assert.deepEqual(runSteps("idle").map((step) => step.state), ["waiting", "waiting", "waiting", "waiting"]);
});

test("summary ranks connection, recovery, activity, requests, failures, and fresh installs", () => {
  assert.equal(updaterSummary({ ...idle, connected: false, state: "pulling" }, NOW), "offline");
  assert.equal(updaterSummary({ ...idle, state: "failed", progress: { ...progress, startup: "manual_recovery" } }, NOW), "recovery");
  assert.equal(updaterSummary({ ...idle, state: "checking" }, NOW), "checking");
  assert.equal(updaterSummary({ ...idle, state: "pulling", progress, pending: "update" }, NOW), "running");
  assert.equal(updaterSummary({ ...idle, state: "failed", pending: "update" }, NOW), "requested");
  const rolledBack = { action: "update" as const, outcome: "rolled_back" as const, at: "2026-11-16T11:00:00Z", detail: null, commandId: null };
  assert.equal(updaterSummary({ ...idle, state: "failed", lastResult: rolledBack }, NOW), "rolled_back");
  const updated = { ...rolledBack, outcome: "updated" as const, at: "2026-11-16T11:50:00Z" };
  assert.equal(updaterSummary({ ...idle, lastResult: updated }, NOW), "installed");
  assert.equal(updaterSummary({ ...idle, lastResult: { ...updated, at: "2026-11-16T11:00:00Z" }, available: true }, NOW), "available");
  assert.equal(updaterSummary({ ...idle, pinned: true }, NOW), "pinned");
  assert.equal(updaterSummary(idle, NOW), "current");
});

test("the overview only surfaces summaries that need a look", () => {
  for (const summary of ["requested", "running", "recovery", "failed", "rolled_back", "installed", "available"] as const) {
    assert.equal(summaryNotable(summary), true, summary);
  }
  for (const summary of ["offline", "checking", "pinned", "current"] as const) {
    assert.equal(summaryNotable(summary), false, summary);
  }
});

test("run progress spreads the active step's percent over all steps", () => {
  const download = { downloadedBytes: 1, totalBytes: 2, layersCompleted: 0, layersTotal: 1 };
  assert.deepEqual(runProgress({ state: "pulling", progress: { ...progress, download } }), { step: 2, steps: 4, percent: 37 });
  assert.deepEqual(runProgress({ state: "verifying", progress: { ...progress, completed: 2 } }), { step: 4, steps: 4, percent: 100 });
  assert.deepEqual(runProgress({ state: "rolling_back", progress }), { step: 3, steps: 3, percent: 66 });
  assert.equal(runProgress({ state: "idle", progress }), null);
  assert.equal(runProgress({ state: "failed", progress }), null);
});

test("durations split into whole minutes and seconds and the stopwatch pads like a clock", () => {
  assert.deepEqual(durationParts(84_400), { minutes: 1, seconds: 24 });
  assert.deepEqual(durationParts(-5), { minutes: 0, seconds: 0 });
  assert.equal(stopwatch(9_000), "0:09");
  assert.equal(stopwatch(3_725_000), "1:02:05");
});

test("a chime plays only for a fresh update result this tab saw change", () => {
  const result = { action: "update" as const, outcome: "updated" as const, at: "2026-11-16T11:59:30Z", detail: null, commandId: "cmd-12345678" };
  assert.equal(finishedRunChime(undefined, result, NOW), null);
  assert.equal(finishedRunChime(result.at, result, NOW), null);
  assert.equal(finishedRunChime(null, result, NOW), "success");
  assert.equal(finishedRunChime("2026-11-16T10:00:00Z", { ...result, outcome: "rolled_back" }, NOW), "failure");
  assert.equal(finishedRunChime(null, { ...result, outcome: "up_to_date" }, NOW), null);
  assert.equal(finishedRunChime(null, { ...result, action: "check", outcome: "failed" }, NOW), null);
  assert.equal(finishedRunChime(null, { ...result, at: "2026-11-16T11:50:00Z" }, NOW), null);
});
