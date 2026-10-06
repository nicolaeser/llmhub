import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const redisImport =
  /(?:from|import\s*\()\s*["'][^"']*(?:ioredis|bullmq|redis)[^"']*["']/;

test("ready probe does not import redis/bullmq/ioredis and still uses prisma.user.count", async () => {
  const ready = await readFile(
    new URL("../src/app/internal-api/ready/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(ready, /prisma\.user\.count\(\)/);
  assert.doesNotMatch(ready, redisImport);
  assert.doesNotMatch(ready, /\bioredis\b|\bbullmq\b|\bredis\b/i);
});

test("health may mention worker but must not await Redis", async () => {
  const health = await readFile(
    new URL("../src/app/internal-api/health/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(health, /worker/);
  assert.doesNotMatch(health, /await\s+getQueueConnectionOptions/);
  assert.doesNotMatch(health, /getQueueConnectionOptions/);
  assert.doesNotMatch(health, /await[\s\S]*\bping\s*\(/);
  assert.doesNotMatch(health, /\.ping\s*\(/);
});
