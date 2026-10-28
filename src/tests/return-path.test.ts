import assert from "node:assert/strict";
import test from "node:test";
import { postLoginDestination, sanitizeReturnPath, withReturnQuery } from "@/lib/auth/return-path";

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

test("every sign-in step ends on the requested deep link with its query or on the start page", () => {
  const deepLink = "/usage?tab=keys&range=7d";
  assert.equal(postLoginDestination(deepLink, "/"), deepLink);
  assert.equal(withReturnQuery("/sso/login", deepLink), "/sso/login?return=%2Fusage%3Ftab%3Dkeys%26range%3D7d");
  for (const unsafe of ["//evil.example", "/\\evil.example", "https://evil.example", "/%2F%2Fevil.example", null]) {
    assert.equal(postLoginDestination(unsafe, "/"), "/", String(unsafe));
    assert.equal(withReturnQuery("/account/login", unsafe), "/account/login", String(unsafe));
  }
});
