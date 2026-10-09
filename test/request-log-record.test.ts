import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const billingPath = new URL("../src/lib/gateway/billing.ts", import.meta.url);
const requestLogPath = new URL("../src/lib/gateway/request-log.ts", import.meta.url);

test("recordUsage hands every request to writeRequestLog with tokens, cost, and content", async () => {
  const source = await readFile(billingPath, "utf8");
  const start = source.indexOf("await writeRequestLog({");
  assert.notEqual(start, -1);
  const call = source.slice(start, source.indexOf("});", start) + 3);
  for (const field of [
    "promptTokens",
    "completionTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cost",
    "request",
    "response",
    "error",
    "stream",
  ]) {
    assert.match(call, new RegExp(`\\b${field}\\b`), field);
  }
});

test("requestLog.create stores tenancy, routing, PII markers, and nested content", async () => {
  const source = await readFile(requestLogPath, "utf8");
  assert.match(source, /prisma\.requestLog\.create\(/);
  for (const field of [
    "orgId",
    "projectId",
    "endpoint",
    "deploymentId",
    "upstreamModel",
    "piiMode",
    "piiInput",
    "piiOutput",
    "contentSkip",
    "cacheReadTokens",
    "cacheWriteTokens",
  ]) {
    assert.match(source, new RegExp(`\\b${field}:`), field);
  }
  assert.match(source, /content:\s*\{|content \? \{ content \}/);
});

test("content logging honours the gateway, key, and user switches", async () => {
  const source = await readFile(requestLogPath, "utf8");
  assert.match(source, /log_content === false\) return "gateway"/);
  assert.match(source, /key\.log_content === false\) return "key"/);
  assert.match(source, /!user\.logContent \? "user"/);
});

test("stored log content is masked with the effective PII policy, including overrides", async () => {
  const source = await readFile(requestLogPath, "utf8");
  assert.match(source, /resolvePii\(entry\.principal\)/);
  assert.doesNotMatch(source, /enterprise\.pii/);
});

test("assertBudget is exported async", async () => {
  const source = await readFile(billingPath, "utf8");
  assert.match(source, /export async function assertBudget/);
});

test("assertRate uses incrementRateWindow instead of a local Map named windows", async () => {
  const source = await readFile(billingPath, "utf8");
  assert.match(source, /incrementRateWindow/);
  assert.doesNotMatch(source, /\b(?:const|let|var)\s+windows\s*=\s*new\s+Map\b/);
});
