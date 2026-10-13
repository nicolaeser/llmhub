import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { NextResponse } from "next/server";
import type { WorkerMode } from "@/types/jobs";

process.env.BUILD_ID = "v2026.10.06.a449f56";

const queries: string[] = [];
let databaseDown = false;

function recordingModel(model: string) {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => async () => {
        queries.push(`${model}.${method}`);
        if (databaseDown) throw new Error("database unavailable");
        return 1;
      },
    },
  );
}

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, name: string) =>
      name.startsWith("$")
        ? async () => {
            queries.push(name);
            return [];
          }
        : recordingModel(name),
  },
);

const workerModes = { bullmq: true, local: true, unavailable: true } satisfies Record<WorkerMode, true>;

test("the ready probe answers after a single user count and reports not_ready when the database fails", async () => {
  const { GET } = await import("@/app/internal-api/ready/route");
  queries.length = 0;
  databaseDown = false;
  const ready = await GET();
  assert.ok(ready instanceof NextResponse);
  assert.equal(ready.status, 200);
  assert.match(ready.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await ready.json(), { status: "ready" });
  assert.deepEqual(queries, ["user.count"]);

  queries.length = 0;
  databaseDown = true;
  const down = await GET();
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { status: "not_ready" });
  assert.deepEqual(queries, ["user.count"]);
  databaseDown = false;
});

test("the health probe reports the version and the current worker mode", async () => {
  const { GET } = await import("@/app/internal-api/health/route");
  const { VERSION } = await import("@/lib/gateway/core");
  const { setWorkerMode } = await import("@/worker/health");
  queries.length = 0;
  const booting = await GET();
  assert.ok(booting instanceof NextResponse);
  assert.match(booting.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await booting.json(), { status: "ok", version: VERSION, worker: { mode: "unavailable" } });
  for (const mode of Object.keys(workerModes) as WorkerMode[]) {
    setWorkerMode(mode);
    const res = await GET();
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).worker, { mode }, mode);
  }
  assert.deepEqual(queries, []);
});

test("HTTP helpers export no writeJSON and problems are NextResponse problem+json", async () => {
  const api = await import("@/lib/http/api");
  const problem = await import("@/lib/http/problem");
  assert.equal("writeJSON" in api, false);
  assert.equal("writeJSON" in problem, false);
  const res = problem.problemResponse(new Request("http://hub.local/internal-api/ready"), "FORBIDDEN");
  assert.ok(res instanceof NextResponse);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  assert.equal((await res.json()).code, "FORBIDDEN");
});

test("only /internal-api exposes health and ready", () => {
  for (const route of ["health", "health/ready", "metrics"]) {
    assert.equal(existsSync(new URL(`../src/app/${route}/route.ts`, import.meta.url)), false);
  }
});

test("internal version reports the build id uncached", async () => {
  const { GET } = await import("@/app/internal-api/version/route");
  const response = await GET();
  const body = await response.json();
  assert.equal(body.version, "v2026.10.06.a449f56");
  assert.ok(!Number.isNaN(Date.parse(body.startedAt)));
  assert.ok(Date.parse(body.startedAt) <= Date.now());
  assert.equal(response.headers.get("cache-control"), "no-store");
});
