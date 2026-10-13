import "server-only";
import prisma from "@/lib/db/prisma";

export async function removeUserWithInternalKeys(userId: string): Promise<{ revokedKeys: number }> {
  return prisma.$transaction(async (tx) => {
    const keys = await tx.virtualKey.findMany({
      where: { userId, projectId: null, memberId: null },
      select: { id: true },
    });
    const ids = keys.map((key) => key.id);
    await tx.tempBudget.deleteMany({
      where: {
        OR: [
          { entityType: "key", entityId: { in: ids } },
          { entityType: "user", entityId: userId },
        ],
      },
    });
    const revoked = await tx.virtualKey.deleteMany({ where: { id: { in: ids } } });
    await tx.user.delete({ where: { id: userId, isOwner: false } });
    return { revokedKeys: revoked.count };
  });
}
