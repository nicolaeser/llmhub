import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function file(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("first-admin setup is gated on empty user table at layout and action", async () => {
  const [layout, page, action, dockerfile] = await Promise.all([
    file("src/app/internal-api/setup/layout.tsx"),
    file("src/app/internal-api/setup/page.tsx"),
    file("src/app/internal-api/setup/_action.ts"),
    file("Dockerfile"),
  ]);

  assert.match(layout, /prisma\.user\.count\(\)/);
  assert.match(layout, /redirect\("\/"\)/);
  assert.match(page, /"use client"/);
  assert.match(page, /from "@heroui\/react"/);
  assert.match(page, /TextField/);
  assert.match(page, /<Input/);
  assert.match(page, /router\.replace\("\/"\)/);
  assert.doesNotMatch(page, /<input |<button /);
  assert.doesNotMatch(page, /AccountShell|AuthCard/);
  assert.match(action, /isolationLevel: "Serializable"/);
  assert.match(action, /withSerializableRetry/);
  assert.doesNotMatch(action, /\$queryRaw|\$executeRaw|pg_advisory/);
  assert.match(action, /SetupAlreadyCompleteError/);
  assert.match(action, /tx\.user\.count\(\)/);
  assert.match(action, /templateRoleId\("admin"\)/);
  assert.match(action, /isOwner: true/);
  assert.match(action, /reserveAttempts\(/);
  assert.match(action, /inputErrorCode\(parsed\.error\)/);
  assert.match(dockerfile, /migrate-deploy\.mjs/);
  assert.doesNotMatch(dockerfile, /seed/);
});

test("setup is served from /internal-api/setup through the proxy", async () => {
  const proxy = await file("src/proxy.ts");
  assert.match(proxy, /SETUP_PATTERN = \/\^\\\/internal-api\\\/setup/);
  assert.match(proxy, /internal-api\/\(\?!setup/);
});

test("there is no seed step", async () => {
  const [config, pkg] = await Promise.all([file("prisma.config.ts"), file("package.json")]);
  assert.doesNotMatch(config, /seed/);
  assert.doesNotMatch(pkg, /seed/);
});

test("public registration and SSO cannot create the first user", async () => {
  const [register, login, ssoUser, scim, proxy] = await Promise.all([
    file("src/app/internal-api/account/register/route.ts"),
    file("src/app/account/login/page.tsx"),
    file("src/lib/auth/sso-user.ts"),
    file("src/lib/gateway/scim.ts"),
    file("src/proxy.ts"),
  ]);
  assert.match(register, /SETUP_REQUIRED/);
  assert.match(register, /user\.count\(\)/);
  assert.doesNotMatch(login, /redirect\("\/internal-api\/setup"\)/);
  assert.doesNotMatch(proxy, /redirect\("\/internal-api\/setup"\)/);
  assert.match(ssoUser, /SETUP_REQUIRED|SetupRequiredError|refuseIfNoOperators/);
  assert.match(scim, /SETUP_REQUIRED|SetupRequiredError|refuseIfNoOperators/);
});

test("boot ensures the catalog without migrating or seeding operators", async () => {
  const [instrumentation, catalog, config] = await Promise.all([
    file("src/instrumentation.ts"),
    file("src/lib/bootstrap/system-catalog.ts"),
    file("prisma.config.ts"),
  ]);
  assert.match(instrumentation, /ensureSystemCatalog/);
  assert.doesNotMatch(instrumentation, /migrate/);
  assert.doesNotMatch(catalog, /user\.create/);
  assert.match(catalog, /roleTemplates/);
  assert.match(config, /prisma\/migrations/);
});

test("app source does not use Prisma raw SQL", async () => {
  const files = [
    "src/app/internal-api/setup/_action.ts",
    "src/app/internal-api/ready/route.ts",
    "src/lib/bootstrap/operators.ts",
    "src/lib/bootstrap/system-catalog.ts",
  ];
  for (const relative of files) {
    const source = await file(relative);
    assert.doesNotMatch(source, /\$queryRaw|\$executeRaw/);
  }
});
