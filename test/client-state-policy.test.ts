import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

test("mutations update client state instead of refreshing the router or revalidating the cache", () => {
  const files = sourceFiles(source);
  assert.ok(files.length > 100);
  for (const file of files) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /\brevalidate(Path|Tag)\s*\(|\brouter\.refresh\s*\(/,
      path.relative(source, file),
    );
  }
});
