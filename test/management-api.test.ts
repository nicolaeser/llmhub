import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { requirePermission } from "@/lib/auth/guards";
import { GateError } from "@/lib/gateway/errors";
import { authenticateBearer } from "@/lib/gateway/principal";
import { ApiProblem, problemFromError } from "@/lib/http/problem";
import { authenticateManagementKey } from "@/lib/management/auth";
import { managementRoute, readBody, readQuery } from "@/lib/management/http";
import { isManagementKey, keyScope, managementPermissions, MANAGEMENT_PERMISSIONS } from "@/lib/management/scope";
import { serializeApiKey, serializeUsage } from "@/lib/management/serialize";
import {
  apiKeyCreateSchema,
  budgetUpdateSchema,
  createManagementKeySchema,
  logsQuerySchema,
  modelAliasCreateSchema,
  modelAliasUpdateSchema,
  teamUpdateSchema,
} from "@/schemas/management";
import type { AuthenticatedSession, Permission } from "@/types/auth";

const root = fileURLToPath(new URL("..", import.meta.url));

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

function principal(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "ops", email: "ops@example.com" } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "MANAGEMENT_KEY",
    ipAddress: null,
    userAgent: null,
  };
}

test("management keys never carry more than the management scope and the owner's role", () => {
  assert.equal(isManagementKey("sk-mgmt-abc"), true);
  assert.equal(isManagementKey("sk-hub-abc"), false);
  assert.deepEqual(managementPermissions(["users:manage", "keys:read", "settings:manage", "bogus"]), ["keys:read"]);
  assert.deepEqual(
    keyScope(["keys:read", "keys:manage", "models:manage"], ["keys:read", "models:manage", "users:manage"]),
    ["keys:read", "models:manage"],
  );
  assert.equal(MANAGEMENT_PERMISSIONS.some((permission) => permission.startsWith("users:")), false);
  assert.equal(MANAGEMENT_PERMISSIONS.some((permission) => permission.startsWith("settings:")), false);
  assert.equal(MANAGEMENT_PERMISSIONS.includes("roles:manage" as never), false);
});

test("management key creation requires a step-up code and only management permissions", () => {
  const ok = createManagementKeySchema.safeParse({ name: "ci", permissions: ["keys:read"], days: 90, code: "123456" });
  assert.equal(ok.success, true);
  assert.equal(
    createManagementKeySchema.safeParse({ name: "ci", permissions: ["users:manage"], days: 90, code: "123456" }).success,
    false,
  );
  assert.equal(createManagementKeySchema.safeParse({ name: "ci", permissions: ["keys:read"], days: 90 }).success, false);
  assert.equal(createManagementKeySchema.safeParse({ name: "ci", permissions: [], days: 90, code: "1" }).success, false);
});

test("the /v1 gateway rejects management keys before any lookup", async () => {
  await assert.rejects(authenticateBearer("sk-mgmt-secret"), (err: unknown) => {
    assert.ok(err instanceof GateError);
    assert.equal(err.status, 401);
    assert.equal(err.code, "invalid_api_key");
    return true;
  });
});

test("/api rejects missing and foreign credentials with a bearer challenge", async () => {
  await assert.rejects(authenticateManagementKey(new Request("http://hub.local/api/me")), (err: unknown) => {
    assert.ok(err instanceof ApiProblem);
    assert.equal(err.code, "UNAUTHORIZED");
    return true;
  });
  await assert.rejects(
    authenticateManagementKey(
      new Request("http://hub.local/api/me", { headers: { authorization: "Bearer sk-hub-gateway" } }),
    ),
    (err: unknown) => err instanceof ApiProblem && err.code === "INVALID_API_KEY",
  );
  const handler = managementRoute(null, async () => new Response("unreachable"));
  const res = await handler(new Request("http://hub.local/api/me"), { params: Promise.resolve({}) });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer /);
});

test("delegated principals satisfy requirePermission only within their scope", async () => {
  const scoped = principal(["keys:read"]);
  assert.equal(await runAsPrincipal(scoped, () => requirePermission("keys:read")), scoped);
  await assert.rejects(
    runAsPrincipal(scoped, () => requirePermission("keys:manage")),
    (err: unknown) => err instanceof AuthError && err.code === "FORBIDDEN",
  );
  const guards = readFileSync(path.join(root, "src/lib/auth/guards.ts"), "utf8");
  const requireSession = guards.slice(guards.indexOf("export async function requireSession"), guards.indexOf("export async function requirePermission"));
  assert.doesNotMatch(requireSession, /delegatedPrincipal/);
});

test("every /api handler goes through managementRoute", () => {
  const files = routeFiles(path.join(root, "src/app/api"));
  assert.ok(files.length >= 20);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /export\s+async\s+function/, file);
    assert.doesNotMatch(source, /getSession|cookies\(/, file);
    for (const match of source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = (\w+)/g)) {
      assert.equal(match[2], "managementRoute", `${file} ${match[1]}`);
    }
  }
  const proxy = readFileSync(path.join(root, "src/proxy.ts"), "utf8");
  assert.match(proxy, /\|api\/\|/);
});

test("request bodies are strict, typed, and reported with JSON pointers", async () => {
  const req = (body: string, type = "application/json") =>
    new Request("http://hub.local/api/keys", { method: "POST", headers: { "content-type": type }, body });
  const created = await readBody(req('{"alias":"ci"}'), apiKeyCreateSchema);
  assert.deepEqual(created.models, []);
  assert.equal(created.expires_in_days, 0);

  const unknown = await readBody(req('{"alias":"ci","rpm":5}'), apiKeyCreateSchema).catch((err) => err);
  const unknownBody = await problemFromError(new Request("http://hub.local/api/keys"), unknown).json();
  assert.equal(unknownBody.status, 422);
  assert.deepEqual(unknownBody.errors, [{ pointer: "#/rpm", detail: 'unknown field "rpm"' }]);

  const badIp = await readBody(req('{"alias":"ci","allowed_ips":["nope"]}'), apiKeyCreateSchema).catch((err) => err);
  const badIpBody = await problemFromError(new Request("http://hub.local/api/keys"), badIp).json();
  assert.deepEqual(badIpBody.errors[0].pointer, "#/allowed_ips/0");

  const notJson = await readBody(req("{", "application/json"), apiKeyCreateSchema).catch((err) => err);
  assert.equal(notJson instanceof ApiProblem && notJson.code, "INVALID_JSON");
  const form = await readBody(req("a=1", "application/x-www-form-urlencoded"), apiKeyCreateSchema).catch((err) => err);
  assert.equal(form instanceof ApiProblem && form.code, "UNSUPPORTED_MEDIA_TYPE");

  assert.equal(modelAliasCreateSchema.safeParse({ alias: "a", strategy: "random" }).success, false);
  const priced = modelAliasCreateSchema.parse({ alias: "a", billing_mode: "custom", price_input_per_1k: 0.002 });
  assert.deepEqual([priced.enabled, priced.price_input_per_1k, priced.price_output_per_1k], [true, 0.002, 0]);
  assert.equal(modelAliasCreateSchema.safeParse({ alias: "a", price_output_per_1k: -1 }).success, false);
  assert.equal(modelAliasUpdateSchema.safeParse({ enabled: false }).success, true);
  const night = { start: "22:00", end: "06:00", price_input_per_1k: 0.001, price_output_per_1k: 0.003 };
  assert.equal(
    modelAliasUpdateSchema.safeParse({ price_time_zone: "Europe/Berlin", price_schedule: [night] }).success,
    true,
  );
  assert.equal(modelAliasUpdateSchema.safeParse({ price_time_zone: "Mars/Olympus" }).success, false);
  assert.equal(modelAliasUpdateSchema.safeParse({ price_schedule: [{ ...night, start: "25:00" }] }).success, false);
  assert.equal(priced.price_time_zone, "UTC");
  assert.deepEqual(priced.price_schedule, []);
  assert.equal(teamUpdateSchema.safeParse({}).success, true);
  assert.equal(budgetUpdateSchema.safeParse({ max_budget: 10, budget_duration: "30d" }).success, true);
  assert.equal(budgetUpdateSchema.safeParse({ max_budget: 10, budget_duration: "fortnight" }).success, false);
});

test("query parameters are coerced and invalid ones answer INVALID_PARAMETER", () => {
  const parsed = readQuery(new Request("http://hub.local/api/logs/requests?page=2&page_size=20&status=429"), logsQuerySchema);
  assert.deepEqual([parsed.page, parsed.page_size, parsed.status], [2, 20, 429]);
  assert.throws(
    () => readQuery(new Request("http://hub.local/api/logs/requests?page_size=5000"), logsQuerySchema),
    (err: unknown) =>
      err instanceof ApiProblem &&
      err.code === "INVALID_PARAMETER" &&
      err.options.errors?.[0]?.parameter === "page_size",
  );
});

test("serializers expose snake_case resources with nulls for unset references", () => {
  const key = serializeApiKey({
    token_id: "k1",
    key_name: "sk-hub-abcde",
    key_alias: "ci",
    user_id: "u1",
    team_id: "",
    org_id: "",
    project_id: "",
    member_id: "m1",
    models: ["gpt"],
    templates: [],
    max_budget: 0,
    spend: 1.5,
    rpm_limit: 0,
    tpm_limit: 0,
    budget_duration: "",
    expires: "",
    allowed_ips: [],
    blocked: false,
    pii: null,
    log_content: true,
    created_at: "2026-10-06T00:00:00.000Z",
  });
  assert.equal(key.object, "api_key");
  assert.equal(key.team_id, null);
  assert.equal(key.member_id, "m1");
  assert.equal(key.expires_at, null);
  assert.equal("key" in key, false);
  const usage = serializeUsage({
    days: 7,
    model: "",
    teamId: "t1",
    orgId: "",
    projectId: "",
    memberId: "",
    keyId: "",
    userId: "",
    spend: 2,
    tokens: 10,
    count: 3,
    errors: 1,
    rate429: 0,
    latency: 12,
    p95Latency: 30,
    daily: [],
    byModel: [{ name: "gpt", spend: 2, prompt: 6, completion: 4, requests: 3, errors: 1, rate429: 0 }],
    byTeam: [],
    byOrg: [],
    byProject: [],
    byMember: [],
    byKey: [],
    byUser: [],
    chargeback: [{ name: "-/t1/-/m1/k1/-/gpt", spend: 2, prompt: 6, completion: 4 }],
  });
  assert.deepEqual(usage.filters.team_id, "t1");
  assert.equal(usage.totals.requests, 3);
  assert.deepEqual(usage.chargeback[0], {
    org_id: null,
    team_id: "t1",
    project_id: null,
    member_id: "m1",
    key_id: "k1",
    user_id: null,
    model: "gpt",
    spend: 2,
    prompt_tokens: 6,
    completion_tokens: 4,
  });
});
