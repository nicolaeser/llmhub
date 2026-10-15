import "server-only";
import { cookies } from "next/headers";
import prisma from "@/lib/db/prisma";

const isProduction = process.env.NODE_ENV === "production";
export const WORKSPACE_COOKIE = isProduction ? "__Host-llmhub-workspace" : "llmhub_workspace";

const cookieBase = {
  path: "/",
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax" as const,
};

export async function readWorkspaceOrgId(isOwner: boolean): Promise<string | null> {
  if (!isOwner) return null;
  const value = (await cookies()).get(WORKSPACE_COOKIE)?.value ?? "";
  if (!/^[a-z0-9]{8,64}$/i.test(value)) return null;
  const org = await prisma.organization.findUnique({ where: { id: value }, select: { id: true } });
  return org?.id ?? null;
}

export async function writeWorkspaceCookie(orgId: string | null): Promise<void> {
  const store = await cookies();
  if (!orgId) {
    store.set(WORKSPACE_COOKIE, "", { ...cookieBase, maxAge: 0 });
    return;
  }
  store.set(WORKSPACE_COOKIE, orgId, { ...cookieBase, maxAge: 60 * 60 * 24 * 365 });
}
