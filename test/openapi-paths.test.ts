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
} from "@/lib/gateway/endpoints/openapi";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = path.join(root, "src/app");
const SURFACES = ["api/v1", "api/subscription", "api/mgmt"] as const;
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

test("OPENAPI_PATHS covers every src/app/api/v1, src/app/api/subscription, and src/app/api/mgmt route method", () => {
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
  assert.deepEqual(openApiPathParams("/api/v1/models/{id}"), ["id"]);
  assert.deepEqual(resolveTryTarget("GET", "/api/v1/models/{id}", { id: "auto" }), {
    ok: true,
    method: "GET",
    path: "/api/v1/models/auto",
  });
  assert.deepEqual(resolveTryTarget("GET", "/api/v1/models/{id}", {}), {
    ok: false,
    error: "MISSING_PARAM",
  });
  assert.deepEqual(resolveTryTarget("POST", "/api/v1/not-a-route", {}), {
    ok: false,
    error: "UNKNOWN_ENDPOINT",
  });
  assert.equal(exampleRequestBody("GET", "/api/v1/models", "gpt"), null);
  assert.match(
    exampleRequestBody("POST", "/api/v1/chat/completions", "gpt") ?? "",
    /"model": "gpt"/,
  );
  assert.match(
    exampleRequestBody("POST", "/api/subscription/v1/chat/completions", "gpt") ?? "",
    /"model": "gpt"/,
  );
  assert.match(exampleRequestBody("POST", "/api/mgmt/keys", "gpt") ?? "", /"alias": "ci-pipeline"/);
  assert.equal(exampleRequestBody("POST", "/api/mgmt/unknown", "gpt"), null);
});
