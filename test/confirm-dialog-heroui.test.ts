import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = path.join(root, "src/components/console/confirm-dialog.tsx");

test("confirm-dialog uses HeroUI AlertDialog compound parts", async () => {
  const source = await readFile(file, "utf8");

  assert.match(source, /import \{[^}]*\bAlertDialog\b[^}]*\} from ["']@heroui\/react["']/);
  assert.match(source, /<AlertDialog\.Trigger>/);
  assert.match(source, /<AlertDialog\.Backdrop\b/);
  assert.match(source, /<AlertDialog\.Container>/);
  assert.match(source, /<AlertDialog\.Dialog\b/);
  assert.match(source, /<AlertDialog\.Header>/);
  assert.match(source, /<AlertDialog\.Heading>/);
  assert.match(source, /<AlertDialog\.Footer>/);
  assert.match(source, /<AlertDialog\.CloseTrigger>/);
  assert.match(source, /<Button\b[^>]*\bvariant=["']danger["']/);
  assert.match(source, /<Button\b[^>]*\bonPress=\{onConfirm\}/);
  assert.match(source, /<Button\b[^>]*\bisPending=\{pending\}/);
  assert.doesNotMatch(source, /\bonClick\b/);
  assert.doesNotMatch(source, /window\.confirm/);
});
