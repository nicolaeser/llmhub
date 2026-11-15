import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildVersion } from "../../scripts/build-version.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sha = "a1b2c3d" + "0".repeat(33);

test("release versions and image aliases follow the branch contract", () => {
  assert.deepEqual(buildVersion("main", sha, "2026-11-15"), {
    version: "v2026.11.15.a1b2c3d", prerelease: false,
    tags: ["v2026.11.15.a1b2c3d", "a1b2c3d", "latest"],
  });
  assert.deepEqual(buildVersion("development", sha, "2026-11-15"), {
    version: "vdev2026.11.15.a1b2c3d", prerelease: true,
    tags: ["vdev2026.11.15.a1b2c3d", "dev-a1b2c3d", "dev"],
  });
  for (const channel of ["main", "development"]) {
    assert.match(buildVersion(channel, sha, "2026-11-15").version, /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);
  }
});

test("feature branches and malformed commit metadata cannot publish a release", () => {
  for (const channel of ["dev/context", "", "latest"]) assert.throws(() => buildVersion(channel, sha, "2026-11-15"));
  for (const commit of ["a1b2c3d", "HEAD", "--all", "A".repeat(40)]) {
    assert.throws(() => buildVersion("main", commit, "2026-11-15"));
  }
  for (const date of ["2026-02-30", "2026-13-01", "2026.11.15", "2026-11-15\ntags=latest"]) {
    assert.throws(() => buildVersion("main", sha, date));
  }
});

test("the version command uses the built commit date even when HEAD and wall time differ", (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "llmhub-version-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git("init", "--quiet");
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "first"], {
    cwd, env: { ...env, GIT_AUTHOR_DATE: "2020-01-01T10:00:00Z", GIT_COMMITTER_DATE: "2024-02-29T23:00:00-04:00" },
  });
  const built = git("rev-parse", "HEAD");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "second");
  const output = path.join(cwd, "output");
  execFileSync(process.execPath, [path.join(root, "scripts/build-version.mjs")], {
    cwd, env: { ...env, CHANNEL: "development", GITHUB_SHA: built, GITHUB_OUTPUT: output },
  });
  const fields = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  assert.equal(fields.version, `vdev2024.02.29.${built.slice(0, 7)}`);
  assert.equal(fields.prerelease, "true");
  assert.deepEqual(JSON.parse(fields.tags), [fields.version, `dev-${built.slice(0, 7)}`, "dev"]);
});

test("feature pushes run quality checks while only release branches build and publish images", () => {
  const workflow = (name: string) => parse(readFileSync(path.join(root, `.github/workflows/${name}.yml`), "utf8"));
  const verify = workflow("verify");
  const release = workflow("release");
  const pipeline = workflow("pipeline");
  assert.deepEqual(verify.on.push.branches, ["dev/**"]);
  assert.deepEqual(verify.on.pull_request.branches, ["main", "development"]);
  assert.deepEqual(release.on.push.branches, ["main", "development"]);
  assert.equal(verify.jobs.verify.with.publish, undefined);
  assert.equal(release.jobs.build.with.publish, true);
  assert.equal(pipeline.jobs.version.if, "inputs.publish");
  assert.equal(pipeline.jobs.image.if, "inputs.publish");
  assert.equal(pipeline.jobs.quality.if, undefined);
  assert.equal(verify.jobs.dependencies.if, "github.event_name == 'pull_request'");
  assert.equal(pipeline.jobs.version.steps[0].uses, "actions/checkout@v7");
});
