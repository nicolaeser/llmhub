import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const reporter = fileURLToPath(new URL("./failure-reporter.mjs", import.meta.url));

const testFiles = {
  "passing.test.mjs": [
    'import test from "node:test";',
    'console.log("output of a passing file");',
    'test("a passing test", () => {});',
  ],
  "failing.test.mjs": [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'console.log("output of a failing file");',
    'test("a sibling that passes", () => {});',
    'test("a failing test", () => assert.equal(1, 2));',
  ],
  "crashing.test.mjs": ['throw new Error("broken import");'],
  "warning.test.mjs": [
    'import test from "node:test";',
    'test("a test that warns", () => process.emitWarning("a deprecated call", "DeprecationWarning"));',
  ],
};

test("the CI test reporter prints failures with their file's output, process warnings, and the summary, but no passing tests", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "llmhub-reporter-"));
  try {
    await Promise.all(
      Object.entries(testFiles).map(([name, lines]) => writeFile(path.join(dir, name), `${lines.join("\n")}\n`)),
    );
    const run = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, ...Object.keys(testFiles)], {
      cwd: dir,
      encoding: "utf8",
      env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "" },
    });
    assert.equal(run.status, 1, run.stderr);
    const output = run.stdout;
    assert.doesNotMatch(output, /a passing test|output of a passing file|a test that warns/);
    assert.match(output, /output of a failing file/);
    assert.match(output, /✖ a failing test/);
    assert.match(output, /AssertionError \[ERR_ASSERTION\]: Expected values to be strictly equal/);
    assert.match(output, /1 !== 2/);
    assert.match(output, /at TestContext\.<anonymous> \(file:\/\/\S*failing\.test\.mjs:\d+:\d+\)/);
    assert.match(output, /Error: broken import/);
    assert.match(output, /\(node:\d+\) DeprecationWarning: a deprecated call/);
    assert.match(output, /ℹ tests 5\nℹ suites 0\nℹ pass 3\nℹ fail 2\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
