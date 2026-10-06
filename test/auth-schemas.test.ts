import assert from "node:assert/strict";
import test from "node:test";
import { AuthError, inputErrorCode, parseAuthInput } from "@/lib/auth/errors";
import {
  newPasswordSchema,
  passwordSignInSchema,
  registerSchema,
  roleWriteSchema,
  secondFactorProofSchema,
  setupSchema,
  totpCodeSchema,
  userCreateSchema,
  userPasswordSchema,
} from "@/schemas/auth";

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof AuthError ? error.code : "unexpected";
  }
}

test("sign-in input is normalized and strict", () => {
  assert.deepEqual(passwordSignInSchema.parse({ email: " Ada@Example.com ", password: "x" }), {
    email: "ada@example.com",
    password: "x",
  });
  assert.equal(passwordSignInSchema.safeParse({ email: "ada@example.com", password: "x", extra: 1 }).success, false);
});

test("new passwords follow the shared password policy", () => {
  assert.equal(newPasswordSchema.safeParse("short1").success, false);
  assert.equal(newPasswordSchema.safeParse("onlyletterspassword").success, false);
  assert.equal(newPasswordSchema.safeParse("1234567890123").success, false);
  assert.equal(newPasswordSchema.safeParse("password123").success, false);
  assert.equal(newPasswordSchema.safeParse("correct-horse-1").success, true);
});

test("password policy failures surface as dedicated error codes", () => {
  assert.equal(codeOf(() => parseAuthInput(newPasswordSchema, "short1")), "WEAK_PASSWORD");
  assert.equal(codeOf(() => parseAuthInput(newPasswordSchema, "password123")), "PASSWORD_GUESSABLE");
  assert.equal(codeOf(() => parseAuthInput(passwordSignInSchema, {})), "VALIDATION");
  assert.equal(codeOf(() => parseAuthInput(newPasswordSchema, "correct-horse-1")), null);
  const weak = registerSchema.safeParse({ username: "ada", email: "ada@example.com", password: "short1" });
  assert.equal(weak.success, false);
  if (!weak.success) assert.equal(inputErrorCode(weak.error), "WEAK_PASSWORD");
});

test("account creation rejects passwords built from the username or email", () => {
  const input = { username: "grace", email: "grace.hopper@example.com", password: "hopper-compiler-7" };
  for (const schema of [registerSchema, setupSchema]) {
    const result = schema.safeParse(input);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(inputErrorCode(result.error), "PASSWORD_GUESSABLE");
  }
  const created = userCreateSchema.safeParse({ ...input, roleId: "r1" });
  assert.equal(created.success, false);
  assert.equal(registerSchema.safeParse({ ...input, password: "correct-horse-1" }).success, true);
});

test("second factor inputs are bounded", () => {
  assert.equal(totpCodeSchema.safeParse({ code: "123456" }).success, true);
  assert.equal(totpCodeSchema.safeParse({ code: "12345a" }).success, false);
  assert.equal(secondFactorProofSchema.safeParse({ method: "sms", code: "1" }).success, false);
  assert.equal(secondFactorProofSchema.safeParse({ method: "recovery", code: "a".repeat(33) }).success, false);
});

test("setting another user's password requires a step-up code", () => {
  const input = { userId: "u1", password: "correct-horse-1", requireChange: true };
  assert.equal(userPasswordSchema.safeParse(input).success, false);
  assert.equal(userPasswordSchema.safeParse({ ...input, code: "123456" }).success, true);
});

test("roles only accept catalog permissions", () => {
  assert.equal(roleWriteSchema.safeParse({ name: "Ops", description: null, permissions: ["keys:read"] }).success, true);
  assert.equal(roleWriteSchema.safeParse({ name: "Ops", description: null, permissions: ["root"] }).success, false);
  assert.equal(
    userCreateSchema.safeParse({ username: "ada", email: "ada@example.com", password: "correct-horse-1", roleId: "r1" }).success,
    true,
  );
});
