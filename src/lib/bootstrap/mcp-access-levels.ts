import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db/prisma";
import { toolSpecs } from "@/lib/mcp/client";
import { legacyGrant } from "@/lib/mcp/legacy-access";
import { classifyTools, toolActionsOf } from "@/lib/mcp/resolve";

export async function adoptMcpAccessLevels(db: Prisma.TransactionClient = prisma): Promise<number> {
  const rows = await db.mcpAssignment.findMany({
    where: { access: "" },
    select: {
      id: true,
      mode: true,
      blockedTools: true,
      blockedActions: true,
      role: { select: { allActions: true, actions: true, tools: true, deniedTools: true } },
      server: { select: { tools: true, toolActions: true } },
    },
  });
  let adopted = 0;
  for (const row of rows) {
    const tools = classifyTools(toolSpecs(row.server.tools), toolActionsOf(row.server.toolActions));
    const grant = legacyGrant(
      { mode: row.mode, blockedTools: row.blockedTools, blockedActions: row.blockedActions, role: row.role },
      tools,
    );
    if (!grant) {
      const { count } = await db.mcpAssignment.deleteMany({ where: { id: row.id, access: "" } });
      adopted += count;
      continue;
    }
    const { count } = await db.mcpAssignment.updateMany({
      where: { id: row.id, access: "" },
      data: { access: grant.access, extraTools: grant.extraTools, blockedTools: grant.blockedTools },
    });
    adopted += count;
  }
  return adopted;
}
