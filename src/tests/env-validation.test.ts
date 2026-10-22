import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvironment } from "@/lib/env";

const valid: Record<string, string | undefined> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://llmhub:llmhub@localhost:5432/llmhub",
  APP_SECRET: "test-app-secret-aaaaaaaaaaaaaaaaaaaa",
};

test("NODE_ENV accepts only production or development", () => {
  assert.equal(parseEnvironment(valid).NODE_ENV, "production");
  assert.equal(parseEnvironment({ ...valid, NODE_ENV: "development" }).NODE_ENV, "development");
  for (const value of [undefined, "", "test", "staging", "Production"]) {
    assert.throws(() => parseEnvironment({ ...valid, NODE_ENV: value }), /NODE_ENV/, String(value));
  }
});

test("missing DATABASE_URL throws", () => {
  assert.throws(
    () => parseEnvironment({ ...valid, DATABASE_URL: undefined }),
    /DATABASE_URL/,
  );
});

test("APP_SECRET is required and at least 32 characters", () => {
  assert.throws(() => parseEnvironment({ ...valid, APP_SECRET: undefined }), /APP_SECRET/);
  assert.throws(() => parseEnvironment({ ...valid, APP_SECRET: "a".repeat(31) }), /APP_SECRET/);
  assert.equal(parseEnvironment({ ...valid, APP_SECRET: "a".repeat(32) }).APP_SECRET, "a".repeat(32));
});

test("one APP_SECRET replaces the separate signing and data keys", () => {
  const parsed = parseEnvironment({ ...valid, JWT_SECRET: "x".repeat(32), HUB_DATA_KEY: "y".repeat(32) });
  assert.equal("JWT_SECRET" in parsed, false);
  assert.equal("HUB_DATA_KEY" in parsed, false);
});

test("NEXT_PUBLIC_APP_URL defaults to localhost", () => {
  assert.equal(parseEnvironment(valid).NEXT_PUBLIC_APP_URL, "http://localhost:3000");
});

test("S3 access keys are optional", () => {
  const parsed = parseEnvironment({
    ...valid,
    S3_ACCESS_KEY_ID: "llmhub",
    S3_SECRET_ACCESS_KEY: "llmhubrustfs",
  });
  assert.equal(parsed.S3_ACCESS_KEY_ID, "llmhub");
  assert.equal(parsed.S3_SECRET_ACCESS_KEY, "llmhubrustfs");
  assert.equal(parseEnvironment(valid).S3_ACCESS_KEY_ID, undefined);
});

test("REDIS_URL is optional", () => {
  assert.equal(parseEnvironment(valid).REDIS_URL, undefined);
  assert.equal(
    parseEnvironment({ ...valid, REDIS_URL: "redis://127.0.0.1:6379" }).REDIS_URL,
    "redis://127.0.0.1:6379",
  );
  assert.equal(parseEnvironment({ ...valid, REDIS_URL: "" }).REDIS_URL, undefined);
});

test("IP_MODE defaults to proxy and accepts only proxy, cloudflare, or direct", () => {
  assert.equal(parseEnvironment(valid).IP_MODE, "proxy");
  assert.equal(parseEnvironment({ ...valid, IP_MODE: "" }).IP_MODE, "proxy");
  for (const mode of ["proxy", "cloudflare", "direct"]) {
    assert.equal(parseEnvironment({ ...valid, IP_MODE: ` ${mode} ` }).IP_MODE, mode);
  }
  for (const value of ["auto", "Proxy", "x-forwarded-for", "true"]) {
    assert.throws(() => parseEnvironment({ ...valid, IP_MODE: value }), /IP_MODE/, value);
  }
});

test("BUILD_ID is optional", () => {
  assert.equal(parseEnvironment(valid).BUILD_ID, undefined);
  assert.equal(parseEnvironment({ ...valid, BUILD_ID: "" }).BUILD_ID, undefined);
  assert.equal(
    parseEnvironment({ ...valid, BUILD_ID: "v2026.10.06.a449f56" }).BUILD_ID,
    "v2026.10.06.a449f56",
  );
});

test("LLMHUB_REDACTOR_URL is an optional http or https URL", () => {
  assert.equal(parseEnvironment(valid).LLMHUB_REDACTOR_URL, undefined);
  assert.equal(parseEnvironment({ ...valid, LLMHUB_REDACTOR_URL: " " }).LLMHUB_REDACTOR_URL, undefined);
  assert.equal(
    parseEnvironment({ ...valid, LLMHUB_REDACTOR_URL: " http://redactor:8080 " }).LLMHUB_REDACTOR_URL,
    "http://redactor:8080",
  );
  for (const value of ["redactor:8080", "ftp://redactor", "not a url"]) {
    assert.throws(() => parseEnvironment({ ...valid, LLMHUB_REDACTOR_URL: value }), /LLMHUB_REDACTOR_URL/, value);
  }
});

test("removed settings are not part of the environment", () => {
  const parsed = parseEnvironment({
    ...valid,
    JWT_SECRET_PREVIOUS: "x",
    OIDC_CLIENT_ID: "hub",
    SMTP_HOST: "smtp",
    WORKER_DISABLED: "1",
  });
  assert.equal("JWT_SECRET_PREVIOUS" in parsed, false);
  assert.equal("OIDC_CLIENT_ID" in parsed, false);
  assert.equal("SMTP_HOST" in parsed, false);
  assert.equal("WORKER_DISABLED" in parsed, false);
});

test("optional secrets stay undefined when empty", () => {
  const parsed = parseEnvironment({ ...valid, OIDC_CLIENT_SECRET: "secret", SMTP_URL: "" });
  assert.equal(parsed.OIDC_CLIENT_SECRET, "secret");
  assert.equal(parsed.SMTP_URL, undefined);
  assert.equal(parseEnvironment(valid).OIDC_CLIENT_SECRET, undefined);
});
