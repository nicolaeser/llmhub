import "server-only";
import prisma from "@/lib/db/prisma";

export class SetupRequiredError extends Error {
  readonly code = "SETUP_REQUIRED";
  constructor() {
    super("SETUP_REQUIRED");
    this.name = "SetupRequiredError";
  }
}

export class SetupAlreadyCompleteError extends Error {
  constructor() {
    super("SETUP_ALREADY_COMPLETE");
    this.name = "SetupAlreadyCompleteError";
  }
}

export async function operatorCount(
  db: { user: { count: () => Promise<number> } } = prisma,
): Promise<number> {
  return db.user.count();
}

export async function refuseIfNoOperators(): Promise<void> {
  if ((await operatorCount()) === 0) throw new SetupRequiredError();
}
