import assert from "node:assert/strict";
import test from "node:test";
import { serializeQueries, type QueryRunner } from "@/lib/db/sequential-client";

type Callback = (error: unknown, result?: unknown) => void;
type Call = { text: string; values: unknown };

function textOf(config: unknown): string {
  if (typeof config === "string") return config;
  if (typeof config === "object" && config !== null && "text" in config) return String(config.text);
  return "submittable";
}

function settleLater(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeConnection() {
  const calls: Call[] = [];
  let active = 0;
  let maxActive = 0;
  const outcome = async (text: string) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await settleLater();
    active -= 1;
    if (text.startsWith("fail")) throw new Error(text);
    return { rows: [text] };
  };
  const run: QueryRunner = (config, values, callback) => {
    if (config == null) throw new TypeError("Client was passed a null or undefined query");
    const text = textOf(config);
    calls.push({ text, values });
    if (text === "submittable") return config;
    if (typeof callback === "function") {
      outcome(text).then(
        (result) => (callback as Callback)(null, result),
        (error: unknown) => (callback as Callback)(error),
      );
      return undefined;
    }
    return outcome(text);
  };
  return { calls, run, maxActive: () => maxActive };
}

function viaCallback(query: QueryRunner, config: unknown, values?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const done: Callback = (error, result) => (error ? reject(error) : resolve(result));
    if (values === undefined) query(config, done);
    else query(config, values, done);
  });
}

test("promise queries on one connection run one after another in call order", async () => {
  const connection = fakeConnection();
  const query = serializeQueries(connection.run);
  const results = await Promise.all([query("one"), query({ text: "two" }, [2]), query("three")]);
  assert.deepEqual(results, [{ rows: ["one"] }, { rows: ["two"] }, { rows: ["three"] }]);
  assert.deepEqual(connection.calls, [
    { text: "one", values: undefined },
    { text: "two", values: [2] },
    { text: "three", values: undefined },
  ]);
  assert.equal(connection.maxActive(), 1);
});

test("a failed query rejects for its caller and does not block the queries behind it", async () => {
  const connection = fakeConnection();
  const query = serializeQueries(connection.run);
  const [first, failed, last] = await Promise.allSettled([query("one"), query("fail-two"), query("three")]);
  assert.deepEqual(first, { status: "fulfilled", value: { rows: ["one"] } });
  assert.equal(failed.status, "rejected");
  assert.equal(failed.status === "rejected" && (failed.reason as Error).message, "fail-two");
  assert.deepEqual(last, { status: "fulfilled", value: { rows: ["three"] } });
  assert.equal(connection.maxActive(), 1);
  assert.deepEqual(await query("four"), { rows: ["four"] });
});

test("an invalid query throws at once when the connection is idle and rejects when it waits", async () => {
  const connection = fakeConnection();
  const query = serializeQueries(connection.run);
  assert.throws(() => query(null), TypeError);
  const running = query("one");
  const waiting = query(null) as Promise<unknown>;
  await assert.rejects(waiting, TypeError);
  assert.deepEqual(await running, { rows: ["one"] });
  assert.deepEqual(await query("two"), { rows: ["two"] });
});

test("callback queries share the same lane as promise queries and keep their values", async () => {
  const connection = fakeConnection();
  const query = serializeQueries(connection.run);
  const results = await Promise.all([
    query("one"),
    viaCallback(query, "two"),
    viaCallback(query, "three", [3]),
    new Promise((resolve, reject) => {
      query({ text: "four", callback: (error: unknown, result: unknown) => (error ? reject(error) : resolve(result)) });
    }),
    viaCallback(query, "fail-five").catch((error: Error) => error.message),
    query("six"),
  ]);
  assert.deepEqual(results, [
    { rows: ["one"] },
    { rows: ["two"] },
    { rows: ["three"] },
    { rows: ["four"] },
    "fail-five",
    { rows: ["six"] },
  ]);
  assert.deepEqual(
    connection.calls.map((call) => call.text),
    ["one", "two", "three", "four", "fail-five", "six"],
  );
  assert.deepEqual(connection.calls[2].values, [3]);
  assert.equal(connection.calls[1].values, undefined);
  assert.equal(connection.maxActive(), 1);
});

test("a callback query that cannot start while waiting reports the error to its callback", async () => {
  const connection = fakeConnection();
  const query = serializeQueries(connection.run);
  const running = query("one");
  const error = await new Promise((resolve) => {
    query(null, (failure: unknown) => resolve(failure));
  });
  assert.ok(error instanceof TypeError);
  assert.deepEqual(await running, { rows: ["one"] });
  assert.deepEqual(await query("two"), { rows: ["two"] });
});

test("submittable queries are returned at once and dispatched in call order", async () => {
  const connection = fakeConnection();
  const query = serializeQueries(connection.run);
  const submittable = { submit: () => undefined };
  const running = query("one");
  assert.equal(query(submittable), submittable);
  const after = query("two");
  assert.deepEqual(
    connection.calls.map((call) => call.text),
    ["one"],
  );
  await running;
  assert.deepEqual(await after, { rows: ["two"] });
  assert.deepEqual(
    connection.calls.map((call) => call.text),
    ["one", "submittable", "two"],
  );
  assert.equal(query(submittable), submittable);
  assert.equal(connection.calls.at(-1)?.text, "submittable");
});
