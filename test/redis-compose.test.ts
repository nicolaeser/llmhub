import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function file(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("dev compose ships a redis:8-alpine service on 127.0.0.1:6379", async () => {
  const source = await file("docker-compose.dev.yml");
  assert.match(
    source,
    /^ {2}redis:\n {4}image: redis:8-alpine\n {4}ports:\n {6}- "127\.0\.0\.1:6379:6379"/m,
  );
});

test("deploy compose keeps redis and postgres off host ports", async () => {
  const source = await file("docker-compose.yml");
  assert.match(source, /^ {2}redis:\n {4}image: redis:8-alpine\n/m);
  assert.match(source, /REDIS_URL: redis:\/\/:\$\{REDIS_PASSWORD\}@redis:6379/);
  assert.doesNotMatch(source, /"[^"\n]*:(5432|6379)"/);
});

test("REDIS_URL is documented for optional local Redis", async () => {
  const readme = await file("README.md");
  assert.match(
    readme,
    /docker compose -f docker-compose\.dev\.yml up -d postgres redis rustfs/,
  );
  assert.match(readme, /REDIS_URL/);
  assert.match(readme, /127\.0\.0\.1:6379/);
});
