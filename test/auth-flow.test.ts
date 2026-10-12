import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import type { AuthenticatedSession, Permission } from "@/types/auth";


function principal(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "session-1",
    user: { id: "user-1", username: "ops", email: "ops@example.test" } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

test("permission guards fail with the FORBIDDEN code that actions return to the console", async () => {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { requirePermission } = await import("@/lib/auth/guards");
  const { runAction } = await import("@/lib/http/action-result");
  const viewer = principal(["keys:read"]);

  assert.equal(await runAsPrincipal(viewer, () => requirePermission("keys:read")), viewer);
  assert.deepEqual(
    await runAsPrincipal(viewer, () => runAction(() => requirePermission("keys:manage"))),
    { ok: false, error: "FORBIDDEN", message: "FORBIDDEN" },
  );
});

test("cookie-authenticated account routes reject cross-site requests before any lookup", async () => {
  const routes = {
    logout: (await import("@/app/internal-api/account/logout/route")).POST,
    register: (await import("@/app/internal-api/account/register/route")).POST,
    "forgot-password": (await import("@/app/internal-api/account/forgot-password/route")).POST,
    "reset-password": (await import("@/app/internal-api/account/reset-password/route")).POST,
  };
  const crossSite: Record<string, string>[] = [
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ];
  for (const [name, handler] of Object.entries(routes)) {
    for (const headers of crossSite) {
      recordedPrisma.reset();
      const res = await handler(
        new NextRequest(`http://localhost:3000/internal-api/account/${name}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", cookie: "llmhub_session=abc.def" },
          body: JSON.stringify({ email: "user@example.test", password: "Sturdy-pass-8146q", token: "t".repeat(32) }),
        }),
      );
      assert.equal(res.status, 403, `${name} ${JSON.stringify(headers)}`);
      assert.equal(res.headers.get("content-type"), "application/problem+json");
      assert.equal((await res.json()).code, "FORBIDDEN");
      assert.deepEqual(recordedPrisma.calls, [], name);
    }
  }
});

test("the maintenance sweep purges stale sessions, sign-in records, and day-old throttle rows", async () => {
  const { runMaintenanceSweep } = await import("@/worker/jobs");
  const { SESSION_IDLE_TTL_MS } = await import("@/lib/auth/cookie");
  const now = new Date("2026-10-12T12:00:00Z");
  recordedPrisma.reset();

  await runMaintenanceSweep(now);

  const where = (model: string, method: string) =>
    recordedPrisma.called(model, method).map((call) => JSON.stringify((call.args as { where: unknown }).where));
  const at = now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  assert.ok(where("session", "deleteMany").some((clause) => clause.includes(iso(at - SESSION_IDLE_TTL_MS))));
  assert.ok(where("session", "deleteMany").some((clause) => clause.includes(`"expiresAt":{"lt":"${iso(at)}"}`)));
  assert.ok(where("loginChallenge", "deleteMany").some((clause) => clause.includes(iso(at - 3_600_000))));
  assert.ok(where("authCeremony", "deleteMany").some((clause) => clause.includes(iso(at))));
  assert.ok(where("userTotp", "updateMany").some((clause) => clause.includes(iso(at - 24 * 3_600_000))));
  assert.deepEqual(where("loginAttempt", "deleteMany"), [
    JSON.stringify({ createdAt: { lt: new Date(at - 24 * 3_600_000) } }),
  ]);
});

test("unknown accounts still pay for a password hash check", async () => {
  const source = await readFile(new URL("../src/lib/auth/sign-in.ts", import.meta.url), "utf8");
  assert.match(source, /verifyPassword\(user\?\.password \?\? \(await dummyHash\), password\)/);
});
