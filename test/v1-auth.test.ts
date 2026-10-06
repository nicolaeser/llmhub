import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const chatCompletions = path.join(
  root,
  "src/app/v1/chat/completions/route.ts",
);

test(
  "chat/completions route source must call authenticateBearer",
  { skip: !existsSync(chatCompletions) },
  async () => {
    const source = await readFile(chatCompletions, "utf8");
    const chunks = [source];
    for (const match of source.matchAll(/from\s+["'](@\/lib\/[^"']+)["']/g)) {
      const spec = match[1];
      if (!spec) continue;
      const resolved = path.join(root, spec.replace(/^@\//, "src/") + ".ts");
      if (existsSync(resolved)) chunks.push(await readFile(resolved, "utf8"));
    }
    assert.match(chunks.join("\n"), /authenticateBearer/);
  },
);
