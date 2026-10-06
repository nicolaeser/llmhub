import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  exampleRequestBody,
  OPENAPI_PATHS,
  openApiPathParams,
  resolveTryTarget,
} from "@/lib/gateway/openapi";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = path.join(root, "src/app");
const SURFACES = ["v1", "api"] as const;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

function fileToPath(file: string): string {
  const rel = path.relative(app, path.dirname(file)).split(path.sep).join("/");
  return `/${rel.replace(/\[([^\]]+)\]/g, "{$1}")}`;
}

test("OPENAPI_PATHS covers every src/app/v1 and src/app/api route method", () => {
  const expected = new Set<string>();
  for (const file of SURFACES.flatMap((surface) => walk(path.join(app, surface)))) {
    const source = readFileSync(file, "utf8");
    const routePath = fileToPath(file);
    for (const method of METHODS) {
      const re = new RegExp(String.raw`export\s+(?:async\s+function\s+${method}\b|const\s+${method}\s*=)`);
      if (re.test(source)) expected.add(`${method} ${routePath}`);
    }
  }
  const actual = new Set(OPENAPI_PATHS.map((p) => `${p.method} ${p.path}`));
  assert.deepEqual([...actual].sort(), [...expected].sort());
});

test("resolveTryTarget fills path params and rejects unknown routes", () => {
  assert.deepEqual(openApiPathParams("/v1/models/{id}"), ["id"]);
  assert.deepEqual(resolveTryTarget("GET", "/v1/models/{id}", { id: "auto" }), {
    ok: true,
    method: "GET",
    path: "/v1/models/auto",
  });
  assert.deepEqual(resolveTryTarget("GET", "/v1/models/{id}", {}), {
    ok: false,
    error: "MISSING_PARAM",
  });
  assert.deepEqual(resolveTryTarget("POST", "/v1/not-a-route", {}), {
    ok: false,
    error: "UNKNOWN_ENDPOINT",
  });
  assert.equal(exampleRequestBody("GET", "/v1/models", "gpt"), null);
  assert.match(
    exampleRequestBody("POST", "/v1/chat/completions", "gpt") ?? "",
    /"model": "gpt"/,
  );
});
