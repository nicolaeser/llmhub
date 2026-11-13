import assert from "node:assert/strict";
import test from "node:test";
import { singleFlight } from "@/lib/utils/single-flight";

function deferred() {
  let release: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { done, release, fail };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("singleFlight runs one call at a time and repeats once for calls made meanwhile", async () => {
  const gates = [deferred(), deferred(), deferred()];
  let runs = 0;
  const reload = singleFlight(() => gates[runs++]!.done);
  reload();
  reload();
  reload();
  reload();
  await turn();
  assert.equal(runs, 1);
  gates[0]!.release();
  await turn();
  assert.equal(runs, 2);
  gates[1]!.release();
  await turn();
  assert.equal(runs, 2);
  reload();
  assert.equal(runs, 3);
});

test("singleFlight keeps working after a rejected or throwing run", async () => {
  const gate = deferred();
  let runs = 0;
  const reload = singleFlight(() => {
    runs += 1;
    if (runs === 1) return gate.done;
    if (runs === 2) throw new Error("sync failure");
    return Promise.resolve();
  });
  reload();
  reload();
  gate.fail(new Error("Failed to fetch"));
  await turn();
  assert.equal(runs, 2);
  reload();
  await turn();
  assert.equal(runs, 3);
});
