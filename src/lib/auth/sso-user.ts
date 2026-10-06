import "server-only";
import { randomBytes } from "node:crypto";
import prisma from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { templateRoleId } from "@/lib/auth/roles";
import { refuseIfNoOperators } from "@/lib/bootstrap/operators";
import type { RoleTemplateKey } from "@/types/auth";

export async function uniqueUsername(base: string): Promise<string> {
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const seed = cleaned || "user";
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? seed : `${seed.slice(0, 36)}-${n}`;
    const exists = await prisma.user.findUnique({ where: { username: candidate } });
    if (!exists) return candidate;
  }
  return `${seed.slice(0, 24)}-${randomBytes(4).toString("hex")}`;
}

export async function upsertUserByEmail(
  email: string,
  templateKey: RoleTemplateKey = "viewer",
): Promise<{ id: string; email: string; blocked: boolean }> {
  const normalized = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { email: normalized },
    select: { id: true, email: true, blocked: true, isOwner: true },
  });
  if (existing?.isOwner) throw new Error("SSO_OWNER");
  if (existing) return existing;
  await refuseIfNoOperators();
  const roleId = await templateRoleId(templateKey);
  const local = normalized.split("@")[0] ?? "user";
  const password = await hashPassword(randomBytes(24).toString("base64url"));
  return prisma.user.create({
    data: {
      username: await uniqueUsername(local),
      email: normalized,
      password,
      roleId,
    },
  });
}
