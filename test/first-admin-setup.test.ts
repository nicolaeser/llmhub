import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { digest } from "@/lib/crypto";
import { env } from "@/lib/env";
import { roleTemplateKeys, roleTemplates } from "@/lib/auth/permissions";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (relative: string) => readFile(path.join(root, relative), "utf8");

const emptyUserTable = { user: { count: () => 0 } };

test("the setup page redirects home once any user exists", async () => {
  const { default: SetupLayout } = await import("@/app/internal-api/setup/layout");
  recordedPrisma.reset({ user: { count: () => 1 } });
  await assert.rejects(SetupLayout({ children: "form" }), (err: unknown) => {
    const digestValue = (err as { digest?: string }).digest ?? "";
    assert.match(digestValue, /^NEXT_REDIRECT;/);
    assert.equal(digestValue.split(";")[2], "/");
    return true;
  });
  recordedPrisma.reset(emptyUserTable);
  assert.equal(await SetupLayout({ children: "form" }), "form");
});

test("public registration cannot create the first user", async () => {
  const { POST } = await import("@/app/internal-api/account/register/route");
  recordedPrisma.reset({
    ...emptyUserTable,
    setting: { findUnique: () => ({ key: "enterprise", value: '{"registration_enabled":true}' }) },
    loginAttempt: { create: () => ({ id: "attempt-1" }), count: () => 1 },
  });
  const res = await POST(
    new NextRequest(`${new URL(env.NEXT_PUBLIC_APP_URL).origin}/internal-api/account/register`, {
      method: "POST",
      headers: { origin: new URL(env.NEXT_PUBLIC_APP_URL).origin, "content-type": "application/json" },
      body: JSON.stringify({ username: "first", email: "first@example.test", password: "Sturdy-pass-8146q" }),
    }),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "SETUP_REQUIRED");
  assert.deepEqual(recordedPrisma.called("user", "create"), []);
  assert.deepEqual(recordedPrisma.called("loginAttempt", "deleteMany")[0].args, { where: { id: { in: ["attempt-1"] } } });
});

test("SSO and SCIM provisioning cannot create the first user", async () => {
  const { upsertUserByEmail } = await import("@/lib/auth/sso-user");
  recordedPrisma.reset(emptyUserTable);
  await assert.rejects(upsertUserByEmail("first@example.test"), /SETUP_REQUIRED/);
  assert.deepEqual(recordedPrisma.called("user", "create"), []);

  const { POST } = await import("@/app/scim/v2/Users/route");
  recordedPrisma.reset({
    ...emptyUserTable,
    setting: { findUnique: () => ({ key: "scim_token_hash", value: digest("scim_token") }) },
  });
  const res = await POST(
    new Request("http://localhost:3000/scim/v2/Users", {
      method: "POST",
      headers: { authorization: "Bearer scim_token", "content-type": "application/scim+json" },
      body: JSON.stringify({ userName: "first@example.test" }),
    }),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).detail, "SETUP_REQUIRED");
  assert.deepEqual(recordedPrisma.called("user", "create"), []);
});

test("boot seeds the role templates and settings defaults without creating users", async () => {
  const { ensureSystemCatalog } = await import("@/lib/bootstrap/system-catalog");
  recordedPrisma.reset();
  await ensureSystemCatalog();
  const upserts = recordedPrisma.called("role", "upsert").map((call) => call.args as { where: { templateKey: string }; create: { permissions: string[] } });
  assert.deepEqual(upserts.map((call) => call.where.templateKey), [...roleTemplateKeys]);
  for (const call of upserts) {
    assert.deepEqual(call.create.permissions, [...roleTemplates[call.where.templateKey as keyof typeof roleTemplates]]);
  }
  assert.deepEqual(
    recordedPrisma.called("setting", "upsert").map((call) => (call.args as { where: { key: string } }).where.key),
    ["role_templates_seeded", "enterprise"],
  );
  assert.deepEqual(recordedPrisma.called("user"), []);
});

test("boot only ensures the catalog and the image migrates without seeding", async () => {
  const [instrumentation, dockerfile, config, pkg] = await Promise.all([
    file("src/instrumentation.ts"),
    file("Dockerfile"),
    file("prisma.config.ts"),
    file("package.json"),
  ]);
  assert.match(instrumentation, /ensureSystemCatalog\(\)/);
  assert.doesNotMatch(instrumentation, /migrate/);
  assert.match(dockerfile, /node migrate-deploy\.mjs && exec node server\.js/);
  assert.match(config, /path: "prisma\/migrations"/);
  for (const source of [dockerfile, config, pkg]) assert.doesNotMatch(source, /seed/);
});

test("setup and bootstrap code does not use Prisma raw SQL", async () => {
  for (const relative of [
    "src/lib/bootstrap/first-admin.ts",
    "src/lib/bootstrap/operators.ts",
    "src/lib/bootstrap/system-catalog.ts",
    "src/app/internal-api/ready/route.ts",
  ]) {
    assert.doesNotMatch(await file(relative), /\$queryRaw|\$executeRaw|pg_advisory/, relative);
  }
});

test("the setup form is a client page built from HeroUI fields that returns home", async () => {
  const page = await file("src/app/internal-api/setup/page.tsx");
  assert.match(page, /^"use client";/);
  assert.match(page, /<TextField[\s\S]*<Input/);
  assert.match(page, /router\.replace\("\/"\)/);
  assert.doesNotMatch(page, /AccountShell|AuthCard/);
});

test("the sign-in and registration pages never send visitors to setup", async () => {
  for (const relative of ["src/app/account/login/page.tsx", "src/app/account/register/page.tsx"]) {
    assert.doesNotMatch(await file(relative), /internal-api\/setup/, relative);
  }
});
