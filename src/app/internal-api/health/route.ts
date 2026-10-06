import { NextResponse } from "next/server";
import { VERSION } from "@/lib/gateway/core";
import { workerHealthPayload } from "@/worker/health";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    version: VERSION,
    worker: workerHealthPayload(),
  });
}
