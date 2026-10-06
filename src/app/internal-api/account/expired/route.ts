import { NextResponse } from "next/server";
import { clearedSessionCookieOptions } from "@/lib/auth/cookie";
import { getSession } from "@/lib/auth/session";
import { env } from "@/lib/env";

export async function GET() {
  const session = await getSession();
  if (!session.error) return NextResponse.redirect(new URL("/", env.NEXT_PUBLIC_APP_URL));
  const res = NextResponse.redirect(new URL("/account/login", env.NEXT_PUBLIC_APP_URL));
  res.cookies.set({ ...clearedSessionCookieOptions(), value: "" });
  return res;
}
