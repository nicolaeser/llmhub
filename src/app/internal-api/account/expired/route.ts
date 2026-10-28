import { NextRequest, NextResponse } from "next/server";
import { clearedSessionCookieOptions } from "@/lib/auth/cookie";
import { sanitizeReturnPath, withReturnQuery } from "@/lib/auth/return-path";
import { getSession } from "@/lib/auth/session";
import { env } from "@/lib/env";

export async function GET(req: NextRequest) {
  const returnPath = sanitizeReturnPath(req.nextUrl.searchParams.get("return"));
  const session = await getSession();
  if (!session.error) return NextResponse.redirect(new URL(returnPath ?? "/", env.NEXT_PUBLIC_APP_URL));
  const res = NextResponse.redirect(new URL(withReturnQuery("/account/login", returnPath), env.NEXT_PUBLIC_APP_URL));
  res.cookies.set({ ...clearedSessionCookieOptions(), value: "" });
  return res;
}
