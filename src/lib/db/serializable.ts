import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db/prisma";

const SERIALIZABLE_ATTEMPTS = 3;
const RETRY_JITTER_MS = 25;

export function isSerializableConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "P2034") return true;
  const cause = "cause" in error ? error.cause : null;
  return Boolean(
    cause && typeof cause === "object" && "kind" in cause && cause.kind === "TransactionWriteConflict",
  );
}

export async function withSerializableRetry<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = SERIALIZABLE_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      if (attempt >= attempts || !isSerializableConflict(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * RETRY_JITTER_MS * attempt));
    }
  }
}
