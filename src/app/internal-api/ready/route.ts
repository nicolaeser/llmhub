import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";

export async function GET() {
  try {
    await prisma.user.count();
    return NextResponse.json({ status: "ready" });
  } catch {
    return NextResponse.json({ status: "not_ready" }, { status: 503 });
  }
}
