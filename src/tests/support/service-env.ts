import assert from "node:assert/strict";

export const SERVICE_ENV = [
  "DATABASE_URL",
  "REDIS_URL",
  "SMTP_URL",
  "SMTP_FROM",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "OIDC_CLIENT_SECRET",
  "LLMHUB_REDACTOR_URL",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
] as const;

export type ServiceVariable = (typeof SERVICE_ENV)[number];
export type ServiceEnv = Partial<Record<ServiceVariable, string>>;

export const UNREACHABLE_DATABASE_URL = "postgresql://testdb:testdb@127.0.0.1:1/testdb";
export const UNREACHABLE_REDIS_URL = "redis://127.0.0.1:1";
export const TEST_APP_SECRET = "test-app-secret-aaaaaaaaaaaaaaaaaaaa";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const PRODUCTION_DATABASE_NAME = /(^|[-_])(prod|production)([-_]|$)/i;

export const services: ServiceEnv = {};

export function isTestExecution(
  env: Record<string, string | undefined> = process.env,
  execArgv: readonly string[] = process.execArgv,
): boolean {
  return Boolean(env.NODE_TEST_CONTEXT) || !execArgv.includes("--test");
}

export function isolateOptionalServices(env: NodeJS.ProcessEnv): void {
  for (const name of SERVICE_ENV) {
    if (name === "DATABASE_URL") continue;
    const value = env[name]?.trim();
    if (value) services[name] = value;
    delete env[name];
  }
}

export function isolateServices(env: NodeJS.ProcessEnv): void {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) services.DATABASE_URL = databaseUrl;
  delete env.DATABASE_URL;
  isolateOptionalServices(env);
  env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
}

export function assertDisposableDatabaseUrl(env: Record<string, string | undefined>, suite: string): URL {
  assert.equal(env.NODE_ENV, "development", `${suite} require NODE_ENV=development`);
  const raw = env.DATABASE_URL?.trim();
  assert.ok(raw, `${suite} require DATABASE_URL pointing to a disposable local PostgreSQL server`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    assert.fail(`${suite} require a valid PostgreSQL DATABASE_URL`);
  }
  assert.ok(POSTGRES_PROTOCOLS.has(url.protocol), `${suite} require a PostgreSQL DATABASE_URL`);
  assert.ok(LOOPBACK_HOSTS.has(url.hostname), `${suite} require loopback PostgreSQL`);
  assert.notEqual(url.port, "1", `${suite} cannot run against the unreachable unit-test DATABASE_URL placeholder`);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  assert.ok(database, `${suite} require a database name in DATABASE_URL`);
  assert.equal(
    PRODUCTION_DATABASE_NAME.test(database),
    false,
    `${suite} refuse a production-named database in DATABASE_URL`,
  );
  return url;
}
