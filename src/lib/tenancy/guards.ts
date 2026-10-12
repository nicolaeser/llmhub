import "server-only";

import prisma from "@/lib/db/prisma";
import { companyOf, inCompany } from "@/lib/auth/scope";
import type { AuthenticatedSession } from "@/types/auth";

export function cleanAlias(value: unknown): string {
  const alias = typeof value === "string" ? value.trim() : "";
  if (!alias) throw new Error("ALIAS_REQUIRED");
  if (alias.length > 80) throw new Error("VALIDATION");
  return alias;
}

export function cleanEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || (email && !email.includes("@"))) throw new Error("VALIDATION");
  return email;
}

export function cleanText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new Error("VALIDATION");
  return text;
}

export function cleanLimit(value: unknown, max: number): number {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error("VALIDATION");
  return n;
}

export function assertPlatform(session: AuthenticatedSession) {
  if (companyOf(session)) throw new Error("PLATFORM_ONLY");
}

export function assertInCompany(session: AuthenticatedSession, orgId: string | null | undefined) {
  if (!inCompany(session, orgId)) throw new Error("NOT_FOUND");
}

export async function companyFor(session: AuthenticatedSession, value: unknown): Promise<string> {
  const orgId = typeof value === "string" ? value.trim() : "";
  if (!orgId) throw new Error("ORG_REQUIRED");
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org || !inCompany(session, org.id)) throw new Error("ORG_NOT_FOUND");
  return org.id;
}

export async function departmentFor(value: unknown, orgId: string): Promise<string | null> {
  const teamId = typeof value === "string" ? value.trim() : "";
  if (!teamId) return null;
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, orgId: true } });
  if (!team) throw new Error("TEAM_NOT_FOUND");
  if (team.orgId !== orgId) throw new Error("TEAM_NOT_IN_ORG");
  return team.id;
}
