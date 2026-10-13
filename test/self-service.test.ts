import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { env } from "@/lib/env";

delete process.env.SMTP_URL;
const appOrigin = () => new URL(env.NEXT_PUBLIC_APP_URL).origin;

test("self-registration is off unless an administrator turns it on", async () => {
  const { normalizeEnterprise, getEnterprise } = await import("@/lib/settings/enterprise");
  const { registrationEnabled } = await import("@/lib/auth/self-service");
  assert.equal(normalizeEnterprise({}).registration_enabled, false);
  assert.equal(normalizeEnterprise({ registration_enabled: "true" }).registration_enabled, false);
  assert.equal(normalizeEnterprise({ registration_enabled: true }).registration_enabled, true);

  recordedPrisma.reset();
  assert.equal((await getEnterprise()).registration_enabled, false);
  assert.equal(await registrationEnabled(), false);
  recordedPrisma.reset({ setting: { findUnique: () => ({ key: "enterprise", value: '{"registration_enabled":true}' }) } });
  assert.equal(await registrationEnabled(), true);
});

test("registration refuses before reading the request while it is off", async () => {
  const { POST } = await import("@/app/internal-api/account/register/route");
  recordedPrisma.reset();
  const res = await POST(
    new NextRequest(`${appOrigin()}/internal-api/account/register`, {
      method: "POST",
      headers: { origin: appOrigin(), "content-type": "application/json" },
      body: "{not json",
    }),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "REGISTRATION_DISABLED");
  assert.deepEqual(
    recordedPrisma.calls.map((call) => `${call.model}.${call.method}`),
    ["setting.findUnique"],
  );
});

test("password reset is unavailable without SMTP and touches nothing", async () => {
  const { POST } = await import("@/app/internal-api/account/forgot-password/route");
  recordedPrisma.reset();
  const res = await POST(
    new NextRequest(`${appOrigin()}/internal-api/account/forgot-password`, {
      method: "POST",
      headers: { origin: appOrigin(), "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.test" }),
    }),
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "RESET_DISABLED");
  assert.deepEqual(recordedPrisma.calls, []);
});

test("the login page only links to registration when it is enabled", async () => {
  const page = await readFile(new URL("../src/app/account/login/page.tsx", import.meta.url), "utf8");
  assert.match(page, /context\?\.registrationEnabled && step\.step === null/);
});
