import assert from "node:assert/strict";
import test from "node:test";
import { downloadView, elapsedMilliseconds, recentUpdateRuns } from "../app/(app)/_components/updater-history-view";

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
