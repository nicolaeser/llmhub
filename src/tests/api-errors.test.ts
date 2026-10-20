import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AuthError } from "@/lib/auth/errors";
import {
  ERR_ALL_PAUSED,
  ERR_NO_HEALTHY,
  ERR_NOT_ASSIGNED,
  ERR_UNKNOWN_GROUP,
  limitMessage,
  waitingError,
  waitText,
} from "@/lib/gateway/core";
import { anthropicErrorBody, GateError, gatewayErrorType, openAIErrorBody } from "@/lib/gateway/errors";
import { gateResponse, retryHeaders, toGateError } from "@/lib/gateway/access/gate";
import { upstreamError } from "@/lib/gateway/dispatch/upstream";
import { ApiProblem, PROBLEM_CONTENT_TYPE, problemFromError, problemResponse } from "@/lib/http/problem";
import { isProblemCode, problemSpec } from "@/lib/http/problem-codes";

const root = fileURLToPath(new URL("../..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

test("gateway errors carry type, param, and code in the OpenAI shape", () => {
  const err = new GateError(403, "model_access_denied", "model not allowed for this key", { param: "model" });
  assert.deepEqual(openAIErrorBody(err), {
    error: {
      message: "model not allowed for this key",
      type: "permission_error",
      param: "model",
      code: "model_access_denied",
    },
  });
  assert.equal(openAIErrorBody(new GateError(400, "invalid_json", "bad")).error.param, null);
  assert.equal(gatewayErrorType(401, "invalid_api_key"), "authentication_error");
  assert.equal(gatewayErrorType(404, "not_found"), "not_found_error");
  assert.equal(gatewayErrorType(429, "rate_limit_exceeded"), "rate_limit_error");
  assert.equal(gatewayErrorType(429, "budget_exceeded"), "insufficient_quota");
  assert.equal(gatewayErrorType(502, "upstream_error"), "api_error");
  assert.equal(gatewayErrorType(422, "invalid_request"), "invalid_request_error");
});

test("Anthropic error bodies include the request id when present", () => {
  assert.deepEqual(anthropicErrorBody(404, "missing", "req_1"), {
    type: "error",
    error: { type: "not_found_error", message: "missing" },
    request_id: "req_1",
  });
  assert.equal("request_id" in anthropicErrorBody(400, "bad"), false);
});

test("upstream errors keep the provider code and param except for provider auth failures", () => {
  const context = upstreamError(400, {
    error: { message: "too long", param: "messages", code: "context_length_exceeded" },
  });
  assert.equal(context.status, 400);
  assert.equal(context.code, "context_length_exceeded");
  assert.equal(context.param, "messages");
  const auth = upstreamError(401, { error: { message: "bad key", code: "invalid_api_key" } });
  assert.equal(auth.code, "upstream_error");
  assert.equal(upstreamError(0, {}).status, 502);
});

test("unknown failures map to fixed gateway codes without leaking internals", () => {
  assert.equal(toGateError(ERR_UNKNOWN_GROUP).code, "model_not_found");
  assert.equal(toGateError(ERR_UNKNOWN_GROUP).status, 404);
  assert.equal(toGateError(ERR_NO_HEALTHY).code, "no_healthy_deployment");
  assert.equal(toGateError(ERR_ALL_PAUSED).code, "no_healthy_deployment");
  assert.equal(toGateError(ERR_ALL_PAUSED).status, 503);
  assert.equal(toGateError(ERR_NOT_ASSIGNED).code, "account_not_assigned");
  assert.equal(toGateError(ERR_NOT_ASSIGNED).status, 403);
  assert.equal(toGateError(new TypeError("fetch failed")).status, 502);
  assert.equal(toGateError(Object.assign(new Error("slow"), { name: "TimeoutError" })).status, 504);
  assert.equal(toGateError(Object.assign(new Error("big"), { status: 413 })).code, "payload_too_large");
  assert.equal(toGateError(null).code, "internal_error");
  const hidden = toGateError(new Error("password=hunter2 in query"));
  assert.equal(hidden.status, 500);
  assert.equal(hidden.code, "internal_error");
  assert.doesNotMatch(hidden.message, /hunter2/);
});

test("gateResponse picks the OpenAI or Anthropic shape and sets a request id", async () => {
  const err = new GateError(400, "invalid_request", "messages: Required", { param: "messages" });
  const openai = gateResponse(err, new Request("http://hub.local/v1/chat/completions", { method: "POST" }));
  assert.equal(openai.status, 400);
  assert.match(openai.headers.get("x-request-id") ?? "", /^req_[0-9a-f]{24}$/);
  assert.deepEqual(await openai.json(), {
    error: { message: "messages: Required", type: "invalid_request_error", param: "messages", code: "invalid_request" },
  });

  const messages = gateResponse(err, new Request("http://hub.local/v1/messages", { method: "POST" }));
  const body = await messages.json();
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.request_id, messages.headers.get("request-id"));

  const models = gateResponse(
    new GateError(404, "model_not_found", "model not found", { param: "id" }),
    new Request("http://hub.local/v1/models/x", { headers: { "anthropic-version": "2023-06-01" } }),
  );
  assert.equal((await models.json()).error.type, "not_found_error");
});

test("problem responses follow RFC 9457", async () => {
  const req = new Request("http://hub.local/api/teams?x=1", { method: "POST" });
  const res = problemResponse(req, "ALIAS_EXISTS", { detail: "alias already exists" });
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("content-type"), PROBLEM_CONTENT_TYPE);
  const body = await res.json();
  assert.equal(body.status, 409);
  assert.equal(body.code, "ALIAS_EXISTS");
  assert.equal(body.title, "Alias already exists");
  assert.equal(body.detail, "alias already exists");
  assert.equal(body.instance, "/api/teams");
  assert.match(body.type, /\/api-ref#error-ALIAS_EXISTS$/);
  assert.equal(body.request_id, res.headers.get("x-request-id"));
});

test("problemFromError normalizes every error source", async () => {
  const req = new Request("http://hub.local/api/keys");
  const cases: [unknown, number, string][] = [
    [new ApiProblem("INVALID_API_KEY"), 401, "INVALID_API_KEY"],
    [new AuthError("FORBIDDEN"), 403, "FORBIDDEN"],
    [new Error("Unauthorized"), 401, "UNAUTHORIZED"],
    [new Error("REQUEST_FAILED"), 500, "INTERNAL_ERROR"],
    [new Error("TEAM_NOT_FOUND"), 422, "TEAM_NOT_FOUND"],
    [new GateError(502, "upstream_error", "provider down"), 502, "UPSTREAM_ERROR"],
    [ERR_UNKNOWN_GROUP, 404, "MODEL_NOT_FOUND"],
    [ERR_NOT_ASSIGNED, 403, "ACCOUNT_NOT_ASSIGNED"],
    [ERR_ALL_PAUSED, 503, "NO_HEALTHY_DEPLOYMENT"],
    [Object.assign(new Error("request body is too large"), { status: 413 }), 413, "PAYLOAD_TOO_LARGE"],
    [new Error("connect ECONNREFUSED 10.0.0.1"), 500, "INTERNAL_ERROR"],
  ];
  for (const [err, status, code] of cases) {
    const res = problemFromError(req, err);
    const body = await res.json();
    assert.equal(res.status, status, code);
    assert.equal(body.code, code);
    assert.doesNotMatch(body.detail, /ECONNREFUSED/);
  }
  const parsed = z.object({ alias: z.string().min(1), "a/b": z.number() }).safeParse({ alias: "", "a/b": "x" });
  assert.equal(parsed.success, false);
  const invalid = await problemFromError(req, parsed.error).json();
  assert.equal(invalid.status, 422);
  assert.deepEqual(
    invalid.errors.map((item: { pointer: string }) => item.pointer),
    ["#/alias", "#/a~1b"],
  );
});

test("every error code the HTTP surfaces can emit is in the problem catalog", () => {
  const sources = [
    ...walk(path.join(root, "src/app/api")),
    ...walk(path.join(root, "src/app/internal-api")),
    ...[
      "keys/manage.ts",
      "usage/dashboard.ts",
      "models/groups.ts",
      "models/templates.ts",
      "providers/connections.ts",
      "tenancy/structure.ts",
      "tenancy/budgets.ts",
      "tenancy/guards.ts",
      "reports/manage.ts",
      "pricing/markups.ts",
      "gateway/request-logs/explorer.ts",
    ].map((file) => path.join(root, "src/lib", file)),
  ];
  const codes = new Set<string>();
  for (const file of sources) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:actionFail|new Error|problemResponse\(req,|new ApiProblem)\(?\s*"([A-Z][A-Z0-9_]+)"/g)) {
      codes.add(match[1]!);
    }
  }
  assert.ok(codes.size > 20);
  const missing = [...codes].filter((code) => !isProblemCode(code) && code !== "REQUEST_FAILED");
  assert.deepEqual(missing, []);
  assert.equal(problemSpec("NOT_IN_CATALOG", 503).status, 503);
});

test("limit waits read as short relative durations", () => {
  assert.equal(waitText(0), "1m");
  assert.equal(waitText(59_000), "1m");
  assert.equal(waitText(45 * 60_000), "45m");
  assert.equal(waitText(90 * 60_000), "1h 30m");
  assert.equal(waitText(5 * 3_600_000), "5h");
  assert.equal(waitText(26 * 3_600_000), "1d 2h");
  assert.equal(waitText(7 * 24 * 3_600_000), "7d");
});

test("exhausted subscription accounts become a rate limit error naming the provider and the next reset", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const retryAt = now + 2 * 3_600_000 + 15 * 60_000;
  assert.equal(
    limitMessage({ retryAt, limited: true, kinds: ["claude"] }, now),
    "all Claude subscription (Claude Code) accounts have reached their usage limit; the next one is available again at 2026-01-01T14:15:00.000Z (in 2h 15m)",
  );
  assert.match(limitMessage({ retryAt, limited: true, kinds: [] }, now), /^all deployments for this model are rate limited; /);
  const limited = toGateError(waitingError({ retryAt, limited: true, kinds: ["codex", "claude"] }));
  assert.equal(limited.status, 429);
  assert.equal(limited.code, "rate_limit_exceeded");
  assert.equal(limited.type, "rate_limit_error");
  assert.equal(limited.retryAt, retryAt);
  assert.match(limited.message, /ChatGPT subscription \(Codex\) and Claude subscription \(Claude Code\)/);
  const cooling = toGateError(waitingError({ retryAt: now + 10_000, limited: false, kinds: [] }));
  assert.equal(cooling.status, 503);
  assert.equal(cooling.code, "no_healthy_deployment");
  assert.equal(cooling.retryAt, now + 10_000);
  assert.equal(toGateError(ERR_NO_HEALTHY).retryAt, null);
});

test("retry headers tell clients how long to wait and stop blind retries on long limits", () => {
  const now = 1_700_000_000_000;
  const soon = new GateError(429, "rate_limit_exceeded", "rpm exceeded", { retryAt: now + 12_400 });
  assert.deepEqual(retryHeaders(soon, now), { "retry-after": "13", "x-should-retry": "true" });
  const later = new GateError(429, "rate_limit_exceeded", "limit", { retryAt: now + 3_600_000 });
  assert.deepEqual(retryHeaders(later, now), { "retry-after": "3600", "x-should-retry": "false" });
  const past = new GateError(503, "no_healthy_deployment", "cooling", { retryAt: now - 5_000 });
  assert.deepEqual(retryHeaders(past, now), { "retry-after": "1", "x-should-retry": "true" });
  assert.deepEqual(retryHeaders(new GateError(429, "rate_limit_exceeded", "rpm exceeded"), now), {});
  assert.deepEqual(retryHeaders(new GateError(400, "invalid_request", "bad", { retryAt: now + 1_000 }), now), {});
});

test("gateResponse sends retry headers in both error shapes", async () => {
  const err = new GateError(429, "rate_limit_exceeded", "all accounts limited", { retryAt: Date.now() + 7_200_000 });
  const anthropic = gateResponse(err, new Request("http://hub.local/v1/messages", { method: "POST" }));
  assert.equal(anthropic.status, 429);
  assert.equal((await anthropic.json()).error.type, "rate_limit_error");
  assert.ok(Number(anthropic.headers.get("retry-after")) > 7_000);
  assert.equal(anthropic.headers.get("x-should-retry"), "false");
  const openai = gateResponse(err, new Request("http://hub.local/v1/responses", { method: "POST" }));
  assert.equal(openai.headers.get("x-should-retry"), "false");
  assert.equal((await openai.json()).error.code, "rate_limit_exceeded");
});
