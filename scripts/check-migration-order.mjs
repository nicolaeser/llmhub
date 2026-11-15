#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MIGRATIONS = "prisma/migrations";
const FOLDER = /^(\d{14})_[a-z0-9_]+$/;
const DEFAULT_BASE = "origin/main";

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

export function migrationHistoryProblems(base, head) {
  return [
    ...migrationOrderProblems([...base.keys()], [...head.keys()]),
    ...[...base].flatMap(([name, sql]) =>
      head.has(name) && head.get(name) !== sql ? [`${name} exists on the base branch and its SQL must not change`] : [],
    ),
  ];
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
  const base = new Map(foldersAt(ref).filter((folder) => timestampOf(folder)).map((folder) => [
    folder,
    execFileSync("git", ["show", `${ref}:${MIGRATIONS}/${folder}/migration.sql`], { encoding: "utf8" }),
  ]));
  const head = new Map(workingFolders().map((folder) => [
    folder,
    readFileSync(path.join(MIGRATIONS, folder, "migration.sql"), "utf8"),
  ]));
  const problems = migrationHistoryProblems(base, head);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`migration order is consistent with ${ref}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
