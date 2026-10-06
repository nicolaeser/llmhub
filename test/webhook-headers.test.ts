import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { webhookHeaders } from "@/lib/gateway/alerts";

test("webhook headers omit the signature when the secret is empty", () => {
  assert.deepEqual(webhookHeaders("", "{}"), { "Content-Type": "application/json" });
});

test("webhook headers sign timestamp and body without sending the secret", () => {
  const headers = webhookHeaders("whsec", '{"event":"x"}', 1_800_000_000);
  const expected = createHmac("sha256", "whsec").update('1800000000.{"event":"x"}').digest("hex");
  assert.equal(headers["X-LLMHub-Timestamp"], "1800000000");
  assert.equal(headers["X-LLMHub-Signature"], `sha256=${expected}`);
  assert.equal(headers.Authorization, undefined);
  assert.equal(Object.values(headers).includes("whsec"), false);
});
