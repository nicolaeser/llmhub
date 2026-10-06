import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { digest } from "@/lib/crypto";
import { env } from "@/lib/env";
import { fieldErrors, problemResponse } from "@/lib/http/problem";
import { inputErrorCode } from "@/lib/auth/errors";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { passwordPolicyIssue } from "@/lib/auth/password-policy";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { SYSTEM_ACTOR, securityEvent } from "@/lib/auth/security-events";
import { resetPasswordSchema } from "@/schemas/auth";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req.headers, env.NEXT_PUBLIC_APP_URL)) return problemResponse(req, "FORBIDDEN");
  const body = resetPasswordSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return problemResponse(req, inputErrorCode(body.error), { errors: fieldErrors(body.error) });
  }
  const row = await prisma.passwordResetToken.findUnique({
    where: { hash: digest(body.data.token) },
    include: { user: { select: { email: true, username: true, password: true } } },
  });
  if (!row || row.usedAt || row.expiresAt < new Date()) return problemResponse(req, "INVALID_TOKEN");
  const issue = passwordPolicyIssue(body.data.password, [row.user.email, row.user.username]);
  if (issue) return problemResponse(req, issue);
  if (await verifyPassword(row.user.password, body.data.password)) {
    return problemResponse(req, "PASSWORD_REUSED");
  }
  const { count } = await prisma.passwordResetToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (count !== 1) return problemResponse(req, "INVALID_TOKEN");
  await prisma.user.update({
    where: { id: row.userId },
    data: {
      password: await hashPassword(body.data.password),
      passwordChangedAt: new Date(),
      mustChangePassword: false,
      revision: { increment: 1 },
      sessions: { deleteMany: {} },
      loginChallenges: { deleteMany: {} },
      resetTokens: { deleteMany: {} },
      securityEvents: { create: securityEvent(SYSTEM_ACTOR, "password.reset") },
    },
    select: { id: true },
  });
  return NextResponse.json({ ok: true });
}
