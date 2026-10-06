import "server-only";
import * as argon2 from "@node-rs/argon2";
import { AuthError } from "@/lib/auth/errors";
import { passwordPolicyIssue } from "@/lib/auth/password-policy";

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function assertPasswordPolicy(
  password: string,
  identifiers: readonly (string | null | undefined)[],
): void {
  const issue = passwordPolicyIssue(password, identifiers);
  if (issue) throw new AuthError(issue);
}
