import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const ROUTES = [
  "chat/completions",
  "completions",
  "embeddings",
  "responses",
  "files",
  "batches",
  "moderations",
  "audio/speech",
  "audio/transcriptions",
  "audio/translations",
  "messages",
  "messages/count_tokens",
  "systemone",
  "responses/input_tokens",
  "responses/[id]/input_items",
  "batches/[id]/cancel",
  "ocr",
  "images/generations",
  "images/edits",
  "images/variations",
  "videos",
  "models/[id]",
] as const;

function v1Path(rel: string) {
  return path.join(root, "src/app/v1", rel, "route.ts");
}

function apiPath(rel: string) {
  return path.join(root, "src/app/api", rel, "route.ts");
}

function exportsPostOrGet(source: string) {
  return (
    /\bexport\s+(async\s+)?function\s+(POST|GET)\b/.test(source) ||
    /\bexport\s+const\s+(POST|GET)\s*=/.test(source) ||
    /\bexport\s+\{[^}]*(POST|GET)[^}]*\}/.test(source)
  );
}

async function collectLibSources(
  source: string,
  depth: number,
  seen: Set<string>,
): Promise<string[]> {
  const chunks = [source];
  if (depth <= 0) return chunks;
  for (const match of source.matchAll(/from\s+["'](@\/lib\/[^"']+)["']/g)) {
    const spec = match[1];
    if (!spec) continue;
    const resolved = path.join(root, spec.replace(/^@\//, "src/") + ".ts");
    if (!existsSync(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    const next = await readFile(resolved, "utf8");
    chunks.push(...(await collectLibSources(next, depth - 1, seen)));
  }
  return chunks;
}

async function contractSource(source: string): Promise<string> {
  return (await collectLibSources(source, 2, new Set())).join("\n");
}

for (const rel of ROUTES) {
  const file = v1Path(rel);
  const misplaced = apiPath(rel);
  test(
    `${rel} lives under src/app/v1, exports POST and/or GET, uses NextResponse.json`,
    { skip: !existsSync(file) && !existsSync(misplaced) },
    async () => {
      assert.equal(
        existsSync(misplaced),
        false,
        `${rel} must live under src/app/v1 not src/app/api`,
      );
      assert.equal(existsSync(file), true);
      const source = await readFile(file, "utf8");
      assert.equal(file.includes(`${path.sep}app${path.sep}v1${path.sep}`), true);
      assert.equal(file.includes(`${path.sep}app${path.sep}api${path.sep}`), false);
      assert.equal(exportsPostOrGet(source), true, "must export POST and/or GET");
      const combined = await contractSource(source);
      assert.match(combined, /NextResponse\.json/);
      assert.doesNotMatch(combined, /writeJSON/);
    },
  );
}
