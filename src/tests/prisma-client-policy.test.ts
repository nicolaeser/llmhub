import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "generated" || entry.name === "tests") return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

test("application database access has no raw Prisma SQL or TypedSQL exceptions", () => {
  const violations = sourceFiles(root).filter((file) =>
    /\$(?:queryRaw|executeRaw)(?:Unsafe|Typed)?\b|@prisma\/client\/sql|generated\/prisma\/sql/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(violations.map((file) => path.relative(root, file)), []);
});
