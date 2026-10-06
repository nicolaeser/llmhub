import type { ZodError, ZodType } from "zod";
import { isPasswordPolicyCode } from "@/lib/auth/password-policy";
import type { AuthErrorCode } from "@/types/auth";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
    this.name = "AuthError";
  }
}

export function isPrismaCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: unknown }).code === code,
  );
}

export function inputErrorCode(error: ZodError): AuthErrorCode {
  const policy = error.issues.find((issue) => isPasswordPolicyCode(issue.message));
  return policy && isPasswordPolicyCode(policy.message) ? policy.message : "VALIDATION";
}

export function parseAuthInput<T>(schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new AuthError(inputErrorCode(result.error));
  return result.data;
}
