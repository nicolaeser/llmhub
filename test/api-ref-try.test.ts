import assert from "node:assert/strict";
import test from "node:test";
import { GateError } from "@/lib/gateway/errors";

type User = { id: string; orgId: string | null; isOwner: boolean; blocked: boolean; role: { permissions: string[] } | null };

const lookups: { model: string; method: string; args: unknown }[] = [];
const users = new Map<string, User>();

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, model: string) =>
      new Proxy(
        {},
        {
          get: (_inner, method: string) => async (args: { where?: { id?: string } }) => {
            lookups.push({ model, method, args });
            if (model === "user" && method === "findUnique") return users.get(args.where?.id ?? "") ?? null;
            return null;
          },
        },
      ),
  },
);

const upstreamCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  upstreamCalls.push(String(input));
  return new Response("{}", { headers: { "content-type": "application/json" } });
}) as typeof fetch;

function tryRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/internal-api/api-ref/try", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ method: "GET", path: "/api/v1/models", params: {} }),
  });
}

function invalidKey(status: number, code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof GateError, String(err));
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  };
}

test("the try route rejects cross-site posts before it reads the session or calls the gateway", async () => {
  const { POST } = await import("@/app/internal-api/api-ref/try/route");
  lookups.length = 0;
  const req = tryRequest({ origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  const res = await POST(req);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  assert.equal((await res.json()).code, "FORBIDDEN");
  assert.equal(req.bodyUsed, false);
  assert.deepEqual(lookups, []);
  assert.deepEqual(upstreamCalls, []);
});

test("without a console session the try route never reads the body or calls the gateway", async () => {
  const { POST } = await import("@/app/internal-api/api-ref/try/route");
  const req = tryRequest({});
  const res = await POST(req).catch(() => null);
  assert.ok(res === null || res.status === 401);
  assert.equal(req.bodyUsed, false);
  assert.deepEqual(upstreamCalls, []);
});

test("authenticateBearer turns a console try bearer into the signed-in user's principal", async () => {
  const { authenticateBearer } = await import("@/lib/gateway/access/principal");
  const { mintTryBearer } = await import("@/lib/gateway/access/try-bearer");
  users.set("u-try", { id: "u-try", orgId: null, isOwner: false, blocked: false, role: { permissions: ["playground:use"] } });
  lookups.length = 0;
  const principal = await authenticateBearer(mintTryBearer("u-try"));
  assert.equal(principal.actor, "u-try");
  assert.equal(principal.userId, "u-try");
  assert.equal(principal.key, undefined);
  assert.deepEqual(
    lookups.map((call) => `${call.model}.${call.method}`),
    ["user.findUnique"],
  );
});

test("try bearers need a valid signature, an active user, and playground access", async () => {
  const { authenticateBearer } = await import("@/lib/gateway/access/principal");
  const { mintTryBearer } = await import("@/lib/gateway/access/try-bearer");
  users.set("u-viewer", { id: "u-viewer", orgId: null, isOwner: false, blocked: false, role: { permissions: ["keys:read"] } });
  users.set("u-blocked", { id: "u-blocked", orgId: null, isOwner: false, blocked: true, role: { permissions: ["playground:use"] } });
  users.set("u-try", { id: "u-try", orgId: null, isOwner: false, blocked: false, role: { permissions: ["playground:use"] } });

  await assert.rejects(authenticateBearer(mintTryBearer("u-viewer")), invalidKey(403, "permission_denied"));
  await assert.rejects(authenticateBearer(mintTryBearer("u-blocked")), invalidKey(401, "invalid_api_key"));
  await assert.rejects(authenticateBearer(mintTryBearer("u-missing")), invalidKey(401, "invalid_api_key"));

  lookups.length = 0;
  const expired = mintTryBearer("u-try", Math.floor(Date.now() / 1000) - 3600);
  await assert.rejects(authenticateBearer(expired), invalidKey(401, "invalid_api_key"));
  await assert.rejects(authenticateBearer(`${mintTryBearer("u-try")}x`), invalidKey(401, "invalid_api_key"));
  assert.deepEqual(lookups, []);
});
