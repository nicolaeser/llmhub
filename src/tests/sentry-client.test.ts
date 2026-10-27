import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as Sentry from "@sentry/nextjs";
import { NextRequest } from "next/server";
import { publicSentryEnv, sentryInitOptions } from "@/lib/sentry/options";
import { reportClientError } from "@/lib/sentry/report-client-error";

const source = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("the browser options come from literal NEXT_PUBLIC references", async () => {
  const options = await source("src/lib/sentry/options.ts");
  for (const key of [
    "NEXT_PUBLIC_SENTRY_DSN",
    "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
    "NEXT_PUBLIC_SENTRY_RELEASE",
    "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE",
  ]) {
    assert.ok(options.includes(`${key}: process.env.${key},`), key);
  }
  const entry = await source("src/instrumentation-client.ts");
  assert.match(entry, /sentryInitOptions\(publicSentryEnv\(\)\)/);
  assert.doesNotMatch(entry, /^import .*@sentry\//m, "a static import ships the SDK to every page without a DSN");
  for (const file of [
    "src/instrumentation-client.ts",
    "src/lib/sentry/options.ts",
    "src/lib/sentry/report-client-error.ts",
    "src/proxy.ts",
  ]) {
    assert.doesNotMatch(await source(file), /process\.env\[/, file);
  }
});

test("without a public DSN the client neither initialises nor reports, and the browser may connect only to the app", async () => {
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  const client = await import("@/instrumentation-client");
  client.onRouterTransitionStart("/keys", "push");
  reportClientError(new Error("boom"), { boundary: "app" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Sentry.getClient(), undefined);
  assert.equal(sentryInitOptions(publicSentryEnv()).enabled, false);
  const { proxy } = await import("@/proxy");
  const res = await proxy(new NextRequest("http://localhost:3000/account/login"));
  assert.match(res.headers.get("content-security-policy") ?? "", /connect-src 'self';/);
});

test("a public DSN sets the browser options and opens the content security policy to its ingest host only", async () => {
  process.env.NEXT_PUBLIC_SENTRY_DSN = "https://key@o1.ingest.sentry.example/2";
  process.env.NEXT_PUBLIC_SENTRY_RELEASE = "llmhub@test";
  try {
    const options = sentryInitOptions(publicSentryEnv());
    assert.equal(options.dsn, "https://key@o1.ingest.sentry.example/2");
    assert.equal(options.release, "llmhub@test");
    const { proxy } = await import("@/proxy");
    const res = await proxy(new NextRequest("http://localhost:3000/account/login"));
    assert.match(
      res.headers.get("content-security-policy") ?? "",
      /connect-src 'self' https:\/\/o1\.ingest\.sentry\.example;/,
    );
  } finally {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_RELEASE;
  }
});
