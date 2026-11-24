import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDisposableDatabaseUrl,
  isolateOptionalServices,
  isolateServices,
  services,
  UNREACHABLE_DATABASE_URL,
} from "./support/service-env";

test("unit test setup isolates DATABASE_URL to the unreachable placeholder and clears optional services", () => {
  assert.equal(process.env.DATABASE_URL, UNREACHABLE_DATABASE_URL);
  assert.equal(process.env.REDIS_URL, undefined);
  assert.equal(process.env.SMTP_URL, undefined);
  assert.equal(process.env.SENTRY_DSN, undefined);
});

test("isolateServices captures configured service variables and replaces DATABASE_URL with the unreachable placeholder", () => {
  const before = { ...services };
  try {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://llmhub:llmhub@localhost:5432/llmhub_dev",
      REDIS_URL: "redis://127.0.0.1:6379",
      SMTP_URL: "smtp://127.0.0.1:1025",
      SENTRY_DSN: "https://key@sentry.example/1",
      APP_SECRET: "a".repeat(32),
    };
    isolateServices(env);
    assert.equal(env.DATABASE_URL, UNREACHABLE_DATABASE_URL);
    assert.equal(env.REDIS_URL, undefined);
    assert.equal(env.SMTP_URL, undefined);
    assert.equal(env.SENTRY_DSN, undefined);
    assert.equal(env.APP_SECRET, "a".repeat(32));
    assert.equal(services.DATABASE_URL, "postgresql://llmhub:llmhub@localhost:5432/llmhub_dev");
    assert.equal(services.REDIS_URL, "redis://127.0.0.1:6379");
    assert.equal(services.SMTP_URL, "smtp://127.0.0.1:1025");
    assert.equal(services.SENTRY_DSN, "https://key@sentry.example/1");
  } finally {
    for (const key of Object.keys(services) as (keyof typeof services)[]) delete services[key];
    Object.assign(services, before);
  }
});

test("isolateOptionalServices preserves DATABASE_URL while stripping other external service variables", () => {
  const before = { ...services };
  try {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://llmhub:llmhub@127.0.0.1:5432/llmhub_test",
      REDIS_URL: "redis://127.0.0.1:6379",
      SMTP_URL: "smtp://127.0.0.1:1025",
    };
    isolateOptionalServices(env);
    assert.equal(env.DATABASE_URL, "postgresql://llmhub:llmhub@127.0.0.1:5432/llmhub_test");
    assert.equal(env.REDIS_URL, undefined);
    assert.equal(env.SMTP_URL, undefined);
  } finally {
    for (const key of Object.keys(services) as (keyof typeof services)[]) delete services[key];
    Object.assign(services, before);
  }
});

test("assertDisposableDatabaseUrl accepts local disposable PostgreSQL URLs in development", () => {
  for (const url of [
    "postgresql://llmhub:llmhub@localhost:5432/llmhub",
    "postgresql://testdb:testdb@127.0.0.1:5433/llmhub_test",
    "postgres://user:pass@[::1]:5432/llmhub_dev",
  ]) {
    const parsed = assertDisposableDatabaseUrl({ NODE_ENV: "development", DATABASE_URL: url }, "database tests");
    assert.equal(parsed.toString(), new URL(url).toString());
  }
});

test("assertDisposableDatabaseUrl rejects missing, remote, placeholder, production, and non-development targets", () => {
  const rejected: Record<string, string | undefined>[] = [
    { NODE_ENV: "development" },
    { NODE_ENV: "development", DATABASE_URL: "   " },
    { NODE_ENV: "development", DATABASE_URL: UNREACHABLE_DATABASE_URL },
    { NODE_ENV: "production", DATABASE_URL: "postgresql://llmhub:llmhub@127.0.0.1:5432/llmhub" },
    { DATABASE_URL: "postgresql://llmhub:llmhub@127.0.0.1:5432/llmhub" },
    { NODE_ENV: "development", DATABASE_URL: "not-a-url" },
    { NODE_ENV: "development", DATABASE_URL: "mysql://127.0.0.1:3306/llmhub" },
    { NODE_ENV: "development", DATABASE_URL: "postgresql://llmhub:llmhub@db.example.test:5432/llmhub" },
    { NODE_ENV: "development", DATABASE_URL: "postgresql://llmhub:llmhub@postgres:5432/llmhub" },
    { NODE_ENV: "development", DATABASE_URL: "postgresql://llmhub:llmhub@127.0.0.1:5432/" },
    { NODE_ENV: "development", DATABASE_URL: "postgresql://llmhub:llmhub@127.0.0.1:5432/llmhub_prod" },
    { NODE_ENV: "development", DATABASE_URL: "postgresql://llmhub:llmhub@127.0.0.1:5432/production" },
    { NODE_ENV: "development", DATABASE_URL: "postgresql://llmhub:llmhub@127.0.0.1:5432/prod-llmhub" },
  ];
  for (const env of rejected) {
    assert.throws(() => assertDisposableDatabaseUrl(env, "database tests"), /database tests/, JSON.stringify(env));
  }
});
