import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeReturnPath } from "@/lib/auth/return-path";

test("sanitizeReturnPath accepts an in-app playground path", () => {
  assert.equal(sanitizeReturnPath("/playground"), "/playground");
});

test("sanitizeReturnPath rejects protocol-relative redirects", () => {
  assert.equal(sanitizeReturnPath("//evil.example"), null);
  assert.equal(sanitizeReturnPath("/\\evil.example"), null);
});

test("sanitizeReturnPath rejects account auth loops", () => {
  assert.equal(sanitizeReturnPath("/account/login"), null);
  assert.equal(sanitizeReturnPath("/account/login?return=/playground"), null);
  assert.equal(sanitizeReturnPath("/en/account/login"), null);
});
