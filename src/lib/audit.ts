import "server-only";
import prisma from "@/lib/db/prisma";

export async function writeAudit(input: {
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await prisma.gatewayAuditLog.create({
    data: {
      actor: input.actor,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      beforeJson:
        input.before === undefined ? "" : JSON.stringify(input.before),
      afterJson: input.after === undefined ? "" : JSON.stringify(input.after),
    },
  });
}
