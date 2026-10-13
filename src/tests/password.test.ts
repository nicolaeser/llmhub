import assert from "node:assert/strict";
import test from "node:test";
import { isPasswordPolicyCode, passwordPolicyIssue } from "@/lib/auth/password-policy";

test("passwords need length, a letter, and a number", () => {
  assert.equal(passwordPolicyIssue("short1"), "WEAK_PASSWORD");
  assert.equal(passwordPolicyIssue("onlyletterspassword"), "WEAK_PASSWORD");
  assert.equal(passwordPolicyIssue("1234567890123"), "WEAK_PASSWORD");
  assert.equal(passwordPolicyIssue(`a1${"x".repeat(255)}`), "WEAK_PASSWORD");
  assert.equal(passwordPolicyIssue("correct-horse-1"), null);
  assert.equal(passwordPolicyIssue("Tr0ub4dor&3-plum"), null);
});

test("common, sequential, and repetitive passwords are rejected", () => {
  for (const password of [
    "password12",
    "Password2024!",
    "P@ssw0rd123",
    "qwerty123456",
    "w1nter20245",
    "llmhub2026!",
    "abc1234567",
    "a123456789",
    "aaaaaaaaa1",
    "abab1abab1abab1",
    "1q1q1q1q1q",
  ]) {
    assert.equal(passwordPolicyIssue(password), "PASSWORD_GUESSABLE", password);
  }
});

test("passwords must not contain the account's username or email name", () => {
  assert.equal(
    passwordPolicyIssue("lovelace-2031", ["ada.lovelace@example.com", "ada"]),
    "PASSWORD_GUESSABLE",
  );
  assert.equal(passwordPolicyIssue("Grace-hopper-9x", ["someone@example.com", "GraceHopper"]), "PASSWORD_GUESSABLE");
  assert.equal(passwordPolicyIssue("canada-maple-77", ["ada@example.com", "ada"]), null);
  assert.equal(passwordPolicyIssue("correct-horse-1", [null, undefined, ""]), null);
});

test("policy codes are recognized", () => {
  assert.equal(isPasswordPolicyCode("WEAK_PASSWORD"), true);
  assert.equal(isPasswordPolicyCode("PASSWORD_GUESSABLE"), true);
  assert.equal(isPasswordPolicyCode("VALIDATION"), false);
});
