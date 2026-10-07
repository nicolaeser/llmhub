import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const PAGES = [
  "companies",
  "models",
  "providers",
] as const;

test("confirm-dialog uses AlertDialog", async () => {
  const file = path.join(root, "src/components/console/confirm-dialog.tsx");
  const source = await readFile(file, "utf8");
  assert.match(source, /from ["']@heroui\/react["']/);
  assert.match(source, /\bAlertDialog\b/);
  assert.match(source, /<AlertDialog>/);
});

for (const slug of PAGES) {
  const rel = `src/app/(app)/${slug}/page.tsx`;
  test(`${rel} no longer contains window.confirm`, async () => {
    const source = await readFile(path.join(root, rel), "utf8");
    if (source.includes("window.confirm")) {
      assert.fail(rel);
    }
  });
}
