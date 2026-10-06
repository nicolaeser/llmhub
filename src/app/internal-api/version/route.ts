import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

export async function GET() {
  return NextResponse.json(
    { version: env.BUILD_ID ?? "development", startedAt: STARTED_AT },
    { headers: { "Cache-Control": "no-store" } },
  );
}
