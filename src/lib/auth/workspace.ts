import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { AuthError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/guards";
import { writeWorkspaceCookie } from "@/lib/auth/workspace-cookie";

export async function setWorkspace(raw: unknown) {
  const session = await requireSession();
  if (!session.isOwner) throw new AuthError("FORBIDDEN");
  const orgId = typeof raw === "string" ? raw.trim() : "";
  if (!orgId) {
    await writeWorkspaceCookie(null);
    await writeAudit({
      actor: session.user.id,
      action: "workspace.clear",
      objectType: "organization",
      objectId: session.workspaceOrgId || "",
    });
    return { orgId: null as string | null, alias: "" };
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, alias: true } });
  if (!org) throw new Error("NOT_FOUND");
  await writeWorkspaceCookie(org.id);
  await writeAudit({
    actor: session.user.id,
    action: "workspace.select",
    objectType: "organization",
    objectId: org.id,
    after: { alias: org.alias },
  });
  return { orgId: org.id, alias: org.alias };
}
