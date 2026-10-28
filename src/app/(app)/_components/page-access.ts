import "server-only";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/guards";
import { companyOf } from "@/lib/auth/scope";
import type { AuthenticatedSession } from "@/types/auth";
import { canOpen } from "./nav-data";

export async function requireConsolePage(pathname: string): Promise<AuthenticatedSession> {
  const session = await requireAuth();
  if (!canOpen(session.permissions, pathname, companyOf(session) ? "company" : "platform")) redirect("/");
  return session;
}
