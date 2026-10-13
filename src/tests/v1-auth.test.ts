import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function gatewayHandlers() {
  const files = [
    ...routeFiles(path.join(root, "src/app/api/v1")),
    ...routeFiles(path.join(root, "src/app/api/subscription")),
  ];
  const handlers: { name: string; url: string; method: string; handler: Handler }[] = [];
  for (const file of files) {
    const relative = path.relative(path.join(root, "src/app"), path.dirname(file));
    const url = `http://hub.local/${relative.replace(/\[(\w+)\]/g, "$1-1")}`;
    const mod = (await import(file)) as Record<string, unknown>;
    for (const method of METHODS) {
      if (typeof mod[method] === "function") {
        handlers.push({ name: `${method} /${relative}`, url, method, handler: mod[method] as Handler });
      }
    }
  }
  return handlers;
}

function call(entry: { url: string; method: string; handler: Handler }, headers: Record<string, string>) {
  const body = entry.method === "GET" || entry.method === "DELETE" ? undefined : '{"model":"m"}';
  const req = new Request(entry.url, {
    method: entry.method,
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  const params = Promise.resolve({ id: "id-1", file_id: "file-1", batch_id: "batch-1" });
  return { req, res: entry.handler(req, { params }) };
}

function assertAuthenticationError(name: string, status: number, body: { error?: { code?: string; type?: string } }) {
  assert.equal(status, 401, name);
  assert.ok(
    body.error?.code === "invalid_api_key" || body.error?.type === "authentication_error",
    `${name} ${JSON.stringify(body)}`,
  );
}

test("every /api/v1 and subscription handler rejects requests without a key before reading them", async () => {
  const handlers = await gatewayHandlers();
  assert.ok(handlers.length >= 40);
  for (const entry of handlers) {
    recordedPrisma.reset();
    const { req, res } = call(entry, {});
    const response = await res;
    assertAuthenticationError(entry.name, response.status, await response.json());
    assert.equal(req.bodyUsed, false, entry.name);
    assert.deepEqual(recordedPrisma.calls, [], entry.name);
  }
});

test("every /api/v1 and subscription handler looks up the presented key and rejects unknown ones", async () => {
  for (const entry of await gatewayHandlers()) {
    recordedPrisma.reset();
    const { req, res } = call(entry, { authorization: "Bearer sk-hub-unknown-key" });
    const response = await res;
    assertAuthenticationError(entry.name, response.status, await response.json());
    assert.equal(req.bodyUsed, false, entry.name);
    assert.ok(recordedPrisma.called("virtualKey").length >= 1, entry.name);
  }
});
