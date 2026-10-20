#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MIGRATIONS = "prisma/migrations";
const FOLDER = /^(\d{14})_[a-z0-9_]+$/;
const DEFAULT_BASE = "origin/development";

function timestampOf(folder) {
  return FOLDER.exec(folder)?.[1] ?? null;
}

export function migrationOrderProblems(baseFolders, headFolders) {
  const base = baseFolders.filter((folder) => timestampOf(folder)).sort();
  const head = new Set(headFolders.filter((folder) => timestampOf(folder)));
  const problems = base
    .filter((folder) => !head.has(folder))
    .map((folder) => `${folder} exists on the base branch and must not be renamed or removed`);
  const newest = base.at(-1);
  if (!newest) return problems;
  const known = new Set(base);
  for (const folder of [...head].filter((name) => !known.has(name)).sort()) {
    if (timestampOf(folder) <= timestampOf(newest)) {
      problems.push(`${folder} must use a later timestamp than ${newest}, the newest migration on the base branch`);
    }
  }
  return problems;
}

function foldersAt(ref) {
  return execFileSync("git", ["ls-tree", "--name-only", `${ref}:${MIGRATIONS}`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function workingFolders() {
  return readdirSync(path.join(process.cwd(), MIGRATIONS), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function main() {
  const ref = process.argv[2] || DEFAULT_BASE;
  const problems = migrationOrderProblems(foldersAt(ref), workingFolders());
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`migration order is consistent with ${ref}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
