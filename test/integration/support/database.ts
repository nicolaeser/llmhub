import { randomBytes } from "node:crypto";
import prisma from "@/lib/db/prisma";
import { permissions } from "@/lib/auth/permissions";
import type { AuthenticatedSession } from "@/types/auth";

export function uniqueName(prefix: string): string {
  return `it-${prefix}-${randomBytes(8).toString("hex")}`;
}

export async function createUser(input: { isOwner?: boolean; orgId?: string } = {}) {
  const name = uniqueName("user");
  return prisma.user.create({
    data: {
      username: name,
      email: `${name}@example.test`,
      password: "integration-test-not-a-hash",
      isOwner: input.isOwner ?? false,
      orgId: input.orgId ?? null,
    },
  });
}

export async function ownerSession(): Promise<AuthenticatedSession> {
  const user = await createUser();
  return {
    error: false,
    sessionId: uniqueName("session"),
    user,
    isOwner: true,
    role: null,
    permissions: [...permissions],
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
  await (globalThis as { pool?: { end: () => Promise<void> } }).pool?.end();
}
