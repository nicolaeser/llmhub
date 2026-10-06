import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { AuthError, inputErrorCode, isPrismaCode } from "@/lib/auth/errors";
import { hashPassword } from "@/lib/auth/password";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { registrationEnabled } from "@/lib/auth/self-service";
import { templateRoleId } from "@/lib/auth/roles";
import { issueEnrollmentChallenge } from "@/lib/auth/sign-in";
import { releaseAttempts, reserveAttempts } from "@/lib/auth/throttle";
import { env } from "@/lib/env";
import { clientIp } from "@/lib/http/api";
import { fieldErrors, problemResponse } from "@/lib/http/problem";
import { registerSchema } from "@/schemas/auth";

const HOUR_MS = 60 * 60 * 1000;
const REGISTRATIONS_PER_CLIENT = 20;

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req.headers, env.NEXT_PUBLIC_APP_URL)) return problemResponse(req, "FORBIDDEN");
  if (!(await registrationEnabled())) return problemResponse(req, "REGISTRATION_DISABLED");
  const ip = clientIp(req.headers) || "unknown";
  let reservation: string[];
  try {
    reservation = await reserveAttempts([
      { key: `register:${ip}`, limit: REGISTRATIONS_PER_CLIENT, windowMs: HOUR_MS },
    ]);
  } catch (error) {
    if (error instanceof AuthError) return problemResponse(req, "RATE_LIMITED");
    throw error;
  }
  const body = registerSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    await releaseAttempts(reservation);
    return problemResponse(req, inputErrorCode(body.error), { errors: fieldErrors(body.error) });
  }

  if ((await prisma.user.count()) === 0) {
    await releaseAttempts(reservation);
    return problemResponse(req, "SETUP_REQUIRED");
  }

  const { username, email, password } = body.data;
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
    select: { id: true },
  });
  if (existing) return problemResponse(req, "USER_EXISTS");

  try {
    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: await hashPassword(password),
        passwordChangedAt: new Date(),
        roleId: await templateRoleId("viewer"),
      },
      select: { id: true },
    });
    await issueEnrollmentChallenge(user.id);
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return problemResponse(req, "USER_EXISTS");
    throw error;
  }
  return NextResponse.json({ redirect: "/account/login" });
}
