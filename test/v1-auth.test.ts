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
    const chunks: string[] = [];
    const seen = new Set<string>();
    let frontier = [await readFile(chatCompletions, "utf8")];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      chunks.push(...frontier);
      const next: string[] = [];
      for (const source of frontier) {
        for (const match of source.matchAll(/from\s+["'](@\/lib\/[^"']+)["']/g)) {
          const spec = match[1];
          if (!spec) continue;
          const resolved = path.join(root, spec.replace(/^@\//, "src/") + ".ts");
          if (seen.has(resolved) || !existsSync(resolved)) continue;
          seen.add(resolved);
          next.push(await readFile(resolved, "utf8"));
        }
      }
      frontier = next;
    }
    assert.match(chunks.join("\n"), /authenticateBearer/);
  },
);
