import assert from "node:assert/strict";
import test from "node:test";
import { GateError } from "@/lib/gateway/errors";
import { completionsRequestSchema } from "@/schemas/completions";
import { systemOneRequestSchema } from "@/schemas/decisions";

const keyLookups: string[] = [];

(globalThis as { prisma?: unknown }).prisma = {
  virtualKey: {
    findFirst: async () => {
      keyLookups.push("virtualKey");
      return null;
    },
  },
};

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://hub.local${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

function gateError(status: number, code: string, param?: string) {
  return (err: unknown) => {
    assert.ok(err instanceof GateError, String(err));
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    if (param !== undefined) assert.equal(err.param, param);
    return true;
  };
}

test("validRequest returns the parsed body and rejects invalid ones with invalid_request", async () => {
  const { validRequest } = await import("@/lib/gateway/endpoints/pipeline");
  assert.deepEqual(validRequest(completionsRequestSchema, { model: "m", prompt: "hi" }), { model: "m", prompt: "hi" });
  assert.throws(() => validRequest(completionsRequestSchema, { prompt: "hi" }), gateError(400, "invalid_request", "model"));
  assert.throws(
    () => validRequest(systemOneRequestSchema, { model: "jev", state: "x", questions: {} }, 422),
    gateError(422, "invalid_request", "questions"),
  );
});

test("gatewayRoute answers thrown errors and rejected streams through gateResponse", async () => {
  const { gatewayRoute } = await import("@/lib/gateway/endpoints/pipeline");
  const thrown = gatewayRoute(async () => {
    throw new GateError(404, "model_not_found", "no deployment for model", { param: "model" });
  });
  const res = await thrown(post("/api/v1/chat/completions", "{}"));
  assert.equal(res.status, 404);
  assert.match(res.headers.get("x-request-id") ?? "", /^req_/);
  assert.deepEqual(await res.json(), {
    error: { message: "no deployment for model", type: "not_found_error", param: "model", code: "model_not_found" },
  });

  const openStream = async (): Promise<Response> => {
    throw new GateError(403, "model_access_denied", "fallback model x not allowed for this key", { param: "model" });
  };
  const streaming = gatewayRoute(async () => openStream());
  const denied = await streaming(post("/api/v1/messages", "{}"));
  assert.equal(denied.status, 403);
  const body = await denied.json();
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "permission_error");
  assert.equal(body.request_id, denied.headers.get("request-id"));

  const ok = gatewayRoute(async () => new Response("done"));
  assert.equal(await (await ok(post("/api/v1/chat/completions", "{}"))).text(), "done");
});

test("screenModelRequest authenticates before it reads the body", async () => {
  const { gatewayRoute, screenModelRequest } = await import("@/lib/gateway/endpoints/pipeline");
  const { apiKeyRequest } = await import("@/lib/gateway/protocols/messages");
  const missing = post("/api/v1/chat/completions", "not json");
  await assert.rejects(screenModelRequest(missing), gateError(401, "invalid_api_key"));
  assert.equal(missing.bodyUsed, false);

  const management = post("/api/v1/chat/completions", "not json", { authorization: "Bearer sk-mgmt-abc" });
  await assert.rejects(screenModelRequest(management), gateError(401, "invalid_api_key"));
  assert.deepEqual(keyLookups, []);

  const route = gatewayRoute(async (req) => {
    await screenModelRequest(req, { auth: apiKeyRequest(req) });
    return new Response("unreachable");
  });
  const unknown = post("/api/v1/messages", "not json", { "x-api-key": "sk-unknown" });
  const res = await route(unknown);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.type, "authentication_error");
  assert.deepEqual(keyLookups, ["virtualKey"]);
  assert.equal(unknown.bodyUsed, false);
});
