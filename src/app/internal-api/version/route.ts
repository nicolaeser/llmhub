import { NextResponse } from "next/server";
import { buildInfo } from "@/lib/updates/build";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(buildInfo(), { headers: { "Cache-Control": "no-store" } });
}
