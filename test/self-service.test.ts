import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const src = (relative: string) => readFile(new URL(`../src/${relative}`, import.meta.url), "utf8");

test("self-registration is off unless an administrator enables it", async () => {
  const [settings, route, login] = await Promise.all([
    src("lib/gateway/settings.ts"),
    src("app/internal-api/account/register/route.ts"),
    src("app/account/login/page.tsx"),
  ]);
  assert.match(settings, /registration_enabled: false/);
  assert.match(settings, /registration_enabled: asBool\(rec\.registration_enabled, false\)/);
  assert.ok(route.indexOf("registrationEnabled()") < route.indexOf("registerSchema.safeParse"));
  assert.match(route, /REGISTRATION_DISABLED/);
  assert.match(login, /context\?\.registrationEnabled/);
});

test("password reset is rate limited, single-token, and never blocks on mail", async () => {
  const [forgot, reset] = await Promise.all([
    src("app/internal-api/account/forgot-password/route.ts"),
    src("app/internal-api/account/reset-password/route.ts"),
  ]);
  assert.match(forgot, /consumeQuota\(`reset-ip:\$\{ip\}`/);
  assert.match(forgot, /consumeQuota\(`reset:\$\{digest\(email\)\}`/);
  assert.match(forgot, /passwordResetToken\.deleteMany\(\{ where: \{ userId: user\.id \} \}\)/);
  assert.match(forgot, /after\(/);
  assert.doesNotMatch(forgot, /logger\.\w+\("[^"]*",\s*\{[^}]*\b(url|token|email)\b/);
  assert.match(reset, /resetTokens: \{ deleteMany: \{\} \}/);
});

test("attempt rows outlive the longest throttle window", async () => {
  const [throttle, jobs] = await Promise.all([src("lib/auth/throttle.ts"), src("worker/jobs.ts")]);
  assert.match(throttle, /ATTEMPT_RETENTION_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(jobs, /ATTEMPT_RETENTION_MS/);
});
