import assert from "node:assert/strict";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";

process.env.REDIS_URL = "redis://127.0.0.1:1";

const queries: string[] = [];

(globalThis as { prisma?: unknown }).prisma = {
  user: {
    count: async () => {
      queries.push("user.count");
      return 1;
    },
  },
};

const socketConnects = mock.method(net.Socket.prototype, "connect");

const redisModule = /[\\/](?:ioredis|bullmq)[\\/]|[\\/]lib[\\/](?:redis|jobs)[\\/]/;

function moduleGraph(relativePath: string): string[] {
  const seen = new Set<string>();
  const visit = (mod: NodeJS.Module | undefined) => {
    if (!mod || seen.has(mod.id)) return;
    seen.add(mod.id);
    mod.children.forEach(visit);
  };
  visit(require.cache[fileURLToPath(new URL(relativePath, import.meta.url))]);
  assert.ok(seen.size > 1, relativePath);
  return [...seen];
}

test("the ready probe answers from the database alone while Redis is configured but unreachable", async () => {
  const { GET } = await import("@/app/internal-api/ready/route");
  const res = await GET();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ready" });
  assert.deepEqual(queries, ["user.count"]);
  assert.equal(socketConnects.mock.callCount(), 0);
  assert.deepEqual(moduleGraph("../../src/app/internal-api/ready/route.ts").filter((id) => redisModule.test(id)), []);
});

test("the health probe reports the worker without loading or contacting Redis", async () => {
  const { GET } = await import("@/app/internal-api/health/route");
  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.deepEqual(body.worker, { mode: "unavailable" });
  assert.equal(socketConnects.mock.callCount(), 0);
  assert.deepEqual(moduleGraph("../../src/app/internal-api/health/route.ts").filter((id) => redisModule.test(id)), []);
});
