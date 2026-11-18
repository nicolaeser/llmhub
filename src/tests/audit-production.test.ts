import assert from "node:assert/strict";
import test from "node:test";
import { auditProblems, blockingAdvisories } from "../../scripts/audit-production.mjs";

const PICOMATCH = {
  source: 1,
  name: "picomatch",
  dependency: "picomatch",
  title: "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
  url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
  severity: "high",
  range: "<=4.0.7",
};

const report = (...vias: object[]) => ({
  vulnerabilities: {
    picomatch: { name: "picomatch", severity: "high", via: vias },
    fdir: { name: "fdir", severity: "high", via: ["picomatch"] },
  },
});

const exception = {
  advisory: "GHSA-fc5q-39xc-vjpf",
  package: "picomatch",
  range: "<=4.0.7",
  reviewBy: "2027-01-31",
  reason: "No patched release exists and only build tooling loads it with repository globs.",
};

test("blocking advisories come from advisory entries, once per advisory and package", () => {
  const found = blockingAdvisories(report(PICOMATCH, PICOMATCH, { ...PICOMATCH, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "moderate" }));
  assert.deepEqual(found.map((entry) => `${entry.advisory} ${entry.package}`), ["GHSA-fc5q-39xc-vjpf picomatch"]);
});

test("an advisory without an exception fails the audit", () => {
  assert.equal(auditProblems(report(PICOMATCH), [], "2026-11-18").length, 1);
  assert.equal(auditProblems(report({ ...PICOMATCH, severity: "critical" }), [], "2026-11-18").length, 1);
});

test("a matching exception passes until its review date", () => {
  assert.deepEqual(auditProblems(report(PICOMATCH), [exception], "2027-01-31"), []);
  assert.match(auditProblems(report(PICOMATCH), [exception], "2027-02-01")[0], /expired on 2027-01-31/);
});

test("an exception stops covering an advisory whose range or package changed", () => {
  assert.match(auditProblems(report({ ...PICOMATCH, range: "<4.0.8" }), [exception], "2026-11-18")[0], /range changed from <=4\.0\.7/);
  const problems = auditProblems(report({ ...PICOMATCH, name: "micromatch" }), [exception], "2026-11-18");
  assert.equal(problems.length, 2);
  assert.match(problems[1], /no longer appears/);
});

test("a stale exception and an npm audit error both fail", () => {
  assert.match(auditProblems({ vulnerabilities: {} }, [exception], "2026-11-18")[0], /remove its exception/);
  assert.match(auditProblems({ error: { summary: "registry unreachable" } }, [], "2026-11-18")[0], /registry unreachable/);
});
