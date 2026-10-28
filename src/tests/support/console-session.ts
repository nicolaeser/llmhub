import assert from "node:assert/strict";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import type { Permission } from "@/types/auth";
import { setRequest } from "./next-headers-stub";

export function sessionRow(granted: readonly Permission[], options: { isOwner?: boolean; orgId?: string | null } = {}) {
  return {
    id: "s1",
    expiresAt: new Date(Date.now() + 3_600_000),
    lastActive: new Date(),
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
    user: {
      id: "u1",
      username: "member",
      blocked: false,
      isOwner: options.isOwner ?? false,
      orgId: options.orgId ?? null,
      roleId: "r1",
      role: { id: "r1", templateKey: null, name: "Custom", permissions: [...granted] },
    },
  };
}

export async function signedIn(cookies: Record<string, string> = {}) {
  setRequest({ cookies: { [SESSION_COOKIE]: await signSessionToken("a".repeat(64)), ...cookies } });
}

export async function redirectOf(render: () => Promise<unknown>): Promise<string | null> {
  const thrown = await render().then(
    () => null,
    (err: unknown) => err,
  );
  if (thrown === null) return null;
  const digest = String((thrown as { digest?: unknown } | null)?.digest ?? "");
  assert.match(digest, /^NEXT_REDIRECT;/);
  return digest.split(";")[2] ?? "";
}
