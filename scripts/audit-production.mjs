#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const EXCEPTIONS = ".github/audit-exceptions.json";
const BLOCKING = new Set(["high", "critical"]);

function advisoryId(url) {
  return /GHSA(?:-[0-9a-z]{4}){3}$/i.exec(url ?? "")?.[0] ?? url ?? "unknown advisory";
}

export function blockingAdvisories(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || !BLOCKING.has(via.severity)) continue;
      const advisory = advisoryId(via.url);
      found.set(`${advisory} ${via.name}`, { advisory, package: via.name, range: via.range, severity: via.severity, title: via.title });
    }
  }
  return [...found.values()];
}

export function auditProblems(report, exceptions, today) {
  if (report.error) return [`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`];
  const used = new Set();
  const problems = [];
  for (const finding of blockingAdvisories(report)) {
    const exception = exceptions.find((entry) => entry.advisory === finding.advisory && entry.package === finding.package);
    const label = `${finding.severity} ${finding.advisory} in ${finding.package} ${finding.range}: ${finding.title}`;
    if (!exception) {
      problems.push(label);
      continue;
    }
    used.add(exception);
    if (exception.range !== finding.range) {
      problems.push(`${label} (the advisory range changed from ${exception.range}, so a fix may exist; update or drop the exception)`);
    } else if (exception.reviewBy < today) {
      problems.push(`${label} (the exception expired on ${exception.reviewBy}; review it again)`);
    }
  }
  for (const exception of exceptions) {
    if (!used.has(exception)) problems.push(`${exception.advisory} in ${exception.package} no longer appears; remove its exception`);
  }
  return problems;
}

function main() {
  const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (audit.error) throw audit.error;
  const report = JSON.parse(audit.stdout || "{}");
  const exceptions = JSON.parse(readFileSync(path.join(process.cwd(), EXCEPTIONS), "utf8"));
  const problems = auditProblems(report, exceptions, new Date().toISOString().slice(0, 10));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  const accepted = exceptions.map((entry) => `${entry.advisory} (${entry.package})`).join(", ");
  console.log(accepted ? `no unreviewed high or critical advisories; accepted: ${accepted}` : "no high or critical advisories");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
