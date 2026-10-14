import { NextResponse } from "next/server";
import { mcpClientMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(mcpClientMetadata(), { headers: { "Cache-Control": "public, max-age=3600" } });
}
