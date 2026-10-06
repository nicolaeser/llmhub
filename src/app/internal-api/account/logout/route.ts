import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import {
  CHALLENGE_COOKIE,
  PASSKEY_COOKIE,
  SESSION_COOKIE,
  ceremonyCookieOptions,
  clearedSessionCookieOptions,
} from "@/lib/auth/cookie";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { revokeSessionCookie } from "@/lib/auth/session";
import { digest } from "@/lib/crypto";
import { env } from "@/lib/env";
import { problemResponse } from "@/lib/http/problem";

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req.headers, env.NEXT_PUBLIC_APP_URL)) {
    return problemResponse(req, "FORBIDDEN");
  }
  await revokeSessionCookie(req.cookies.get(SESSION_COOKIE)?.value);
  const challenge = req.cookies.get(CHALLENGE_COOKIE)?.value;
  if (challenge) {
    await prisma.loginChallenge.deleteMany({ where: { tokenHash: digest(challenge) } });
  }
  const res = NextResponse.redirect(new URL("/account/login", env.NEXT_PUBLIC_APP_URL), 303);
  res.cookies.set({ ...clearedSessionCookieOptions(), value: "" });
  for (const name of [CHALLENGE_COOKIE, PASSKEY_COOKIE]) {
    res.cookies.set({ ...ceremonyCookieOptions(name, new Date(0)), value: "" });
  }
  return res;
}
