import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { isDraining } from "@/lib/http/drain";

export async function GET() {
  if (isDraining()) return NextResponse.json({ status: "draining" }, { status: 503 });
  try {
    await prisma.user.count();
    return NextResponse.json({ status: "ready" });
  } catch {
    return NextResponse.json({ status: "not_ready" }, { status: 503 });
  }
}
