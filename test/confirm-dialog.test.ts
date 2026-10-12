import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  assert.match(source, /<AlertDialog\b/);
  assert.match(source, /isOpen=\{state\?\.isOpen\}/);
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

test("key rotation and revocation ask for confirmation first", async () => {
  const source = await readFile(path.join(root, "src/app/(app)/keys/page.tsx"), "utf8");
  assert.match(source, /from "@\/components\/console\/confirm-dialog"/);
  assert.match(source, /<ConfirmDialog[^>]*rotateConfirm\.title[\s\S]*?onConfirm=\{\(\) => rotate\(/);
  assert.match(source, /<ConfirmDialog[^>]*revokeConfirm\.title[\s\S]*?onConfirm=\{\(\) => revoke\(/);
  assert.doesNotMatch(source, /onPress=\{\(\) => (?:rotate|revoke)\(/);
});

test("user and role deletion use the shared ConfirmDialog", async () => {
  for (const rel of ["src/app/(app)/users/page.tsx", "src/app/(app)/roles/page.tsx"]) {
    const source = await readFile(path.join(root, rel), "utf8");
    assert.match(source, /<ConfirmDialog\s+state=\{deleteState\}/, rel);
  }
  const dialogs = await readFile(path.join(root, "src/app/(app)/users/_components/user-dialogs.tsx"), "utf8");
  assert.doesNotMatch(dialogs, /DeleteUserDialog/);
  assert.equal(existsSync(path.join(root, "src/app/(app)/roles/_components/delete-role-dialog.tsx")), false);
});
