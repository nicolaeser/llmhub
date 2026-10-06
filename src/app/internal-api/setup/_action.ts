"use server";

import { headers } from "next/headers";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { templateRoleId } from "@/lib/auth/roles";
import { issueEnrollmentChallenge } from "@/lib/auth/sign-in";
import { AuthError, inputErrorCode } from "@/lib/auth/errors";
import {
  LOGIN_ATTEMPT_WINDOW_MS,
  releaseAttempts,
  reserveAttempts,
} from "@/lib/auth/throttle";
import { ensureSystemCatalog } from "@/lib/bootstrap/system-catalog";
import { writeAudit } from "@/lib/gateway/audit";
import { SetupAlreadyCompleteError } from "@/lib/bootstrap/operators";
import { clientIp } from "@/lib/http/api";
import { logger } from "@/lib/logging/logger";
import { setupSchema } from "@/schemas/auth";
import type { CreateFirstAdminResult } from "@/types/setup";

function isSerializableConflict(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2034",
  );
}

async function withSerializableRetry<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (attempt === 3 || !isSerializableConflict(error)) throw error;
    }
  }
  throw new Error("SETUP_TRANSACTION_FAILED");
}

export async function createFirstAdminAction(
  input: unknown,
): Promise<CreateFirstAdminResult> {
  const headerList = await headers();
  const ip = clientIp(headerList) || "unknown";
  let reservation: string[];
  try {
    reservation = await reserveAttempts([
      { key: `setup:${ip}`, limit: 10, windowMs: LOGIN_ATTEMPT_WINDOW_MS },
    ]);
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: "RATE_LIMITED" };
    throw error;
  }

  const parsed = setupSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: inputErrorCode(parsed.error) };
  }

  await ensureSystemCatalog();
  const adminRoleId = await templateRoleId("admin");
  const email = parsed.data.email;
  const passwordHash = await hashPassword(parsed.data.password);

  try {
    const created = await withSerializableRetry(async (tx) => {
      if ((await tx.user.count()) > 0) {
        throw new SetupAlreadyCompleteError();
      }
      const taken = await tx.user.findFirst({
        where: {
          OR: [{ email }, { username: parsed.data.username }],
        },
        select: { id: true },
      });
      if (taken) throw new Error("VALIDATION");
      return tx.user.create({
        data: {
          username: parsed.data.username,
          email,
          password: passwordHash,
          isOwner: true,
          roleId: adminRoleId,
          passwordChangedAt: new Date(),
        },
      });
    });

    await issueEnrollmentChallenge(created.id);
    await releaseAttempts(reservation);
    await writeAudit({
      actor: created.id,
      action: "setup.owner_created",
      objectType: "user",
      objectId: created.id,
      after: { username: created.username, email: created.email, roleId: adminRoleId },
    });
    logger.info("auth.setup_complete", { userId: created.id });
    return { ok: true };
  } catch (error) {
    if (error instanceof SetupAlreadyCompleteError) {
      return { ok: false, error: "SETUP_ALREADY_COMPLETE" };
    }
    if (error instanceof Error && error.message === "VALIDATION") {
      return { ok: false, error: "VALIDATION" };
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return { ok: false, error: "SETUP_ALREADY_COMPLETE" };
    }
    logger.error("auth.setup_failed", { err: String(error) });
    return { ok: false, error: "CREATE_FAILED" };
  }
}
