import "./support/recorded-prisma";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const OPENAI_ROUTES = [
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
  "rerank",
  "vector_stores",
  "vector_stores/[id]",
  "vector_stores/[id]/search",
  "vector_stores/[id]/files",
  "vector_stores/[id]/files/[file_id]",
  "vector_stores/[id]/file_batches",
] as const;

const ANTHROPIC_ROUTES = ["messages", "messages/count_tokens"] as const;

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function handlersOf(route: string) {
  assert.equal(existsSync(path.join(root, "src/app/api/mgmt", route, "route.ts")), false, `${route} under /api/mgmt`);
  const file = path.join(root, "src/app/api/v1", route, "route.ts");
  assert.equal(existsSync(file), true, `${route} under /api/v1`);
  const mod = (await import(file)) as Record<string, unknown>;
  const handlers = (["GET", "POST"] as const).filter((method) => typeof mod[method] === "function");
  assert.ok(handlers.length > 0, `${route} exports GET or POST`);
  return handlers.map((method) => ({ method, handler: mod[method] as Handler }));
}

async function unauthenticated(route: string, method: string, handler: Handler) {
  const res = await handler(
    new Request(`http://hub.local/api/v1/${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    }),
    { params: Promise.resolve({ id: "id-1", file_id: "file-1" }) },
  );
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/, route);
  assert.match(res.headers.get("x-request-id") ?? "", /^req_/, route);
  return { status: res.status, body: await res.json() };
}

test("OpenAI-compatible routes live under /api/v1 and answer OpenAI JSON errors", async () => {
  for (const route of OPENAI_ROUTES) {
    for (const { method, handler } of await handlersOf(route)) {
      const { status, body } = await unauthenticated(route, method, handler);
      assert.equal(status, 401, route);
      assert.deepEqual(Object.keys(body), ["error"], route);
      assert.equal(body.error.type, "authentication_error", route);
      assert.equal(body.error.code, "invalid_api_key", route);
      assert.equal(typeof body.error.message, "string", route);
    }
  }
});

test("Anthropic-compatible routes live under /api/v1 and answer Anthropic JSON errors", async () => {
  for (const route of ANTHROPIC_ROUTES) {
    for (const { method, handler } of await handlersOf(route)) {
      const { status, body } = await unauthenticated(route, method, handler);
      assert.equal(status, 401, route);
      assert.equal(body.type, "error", route);
      assert.equal(body.error.type, "authentication_error", route);
    }
  }
});
