import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvironment } from "@/lib/env";

const valid: Record<string, string | undefined> = {
  DATABASE_URL: "postgresql://llmhub:llmhub@localhost:5432/llmhub",
  APP_SECRET: "test-app-secret-aaaaaaaaaaaaaaaaaaaa",
};

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

test("BUILD_ID is optional", () => {
  assert.equal(parseEnvironment(valid).BUILD_ID, undefined);
  assert.equal(parseEnvironment({ ...valid, BUILD_ID: "" }).BUILD_ID, undefined);
  assert.equal(
    parseEnvironment({ ...valid, BUILD_ID: "v2026.10.06.a449f56" }).BUILD_ID,
    "v2026.10.06.a449f56",
  );
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
