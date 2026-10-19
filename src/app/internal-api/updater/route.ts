import { NextResponse } from "next/server";
import { updaterKey } from "@/lib/crypto";
import { isPayloadTooLarge, readText } from "@/lib/http/api";
import { fieldErrors, problemResponse } from "@/lib/http/problem";
import { logger } from "@/lib/logging/logger";
import { parseJsonOrNull } from "@/lib/utils/json";
import { receiveUpdaterReport } from "@/lib/updates/updater";
import { signUpdaterBody, UPDATER_HEADER, verifyUpdaterSignature } from "@/lib/updates/updater-signature";
import { UPDATER_BODY_LIMIT, updaterReportSchema } from "@/schemas/updater";

export const dynamic = "force-dynamic";

const REJECTION_LOG_GAP_MS = 60_000;
let lastRejectionLog = 0;

function logRejection(reason: string) {
  const now = Date.now();
  if (now - lastRejectionLog < REJECTION_LOG_GAP_MS) return;
  lastRejectionLog = now;
  logger.warn("updater.rejected", { reason });
}

export async function POST(req: Request) {
  let body: string;
  try {
    body = await readText(req, UPDATER_BODY_LIMIT);
  } catch (err) {
    if (isPayloadTooLarge(err)) return problemResponse(req, "PAYLOAD_TOO_LARGE");
    throw err;
  }
  const key = updaterKey();
  const check = verifyUpdaterSignature(key, req.headers.get(UPDATER_HEADER), body, Date.now());
  if (check !== "ok") {
    logRejection(check);
    return problemResponse(req, "UNAUTHORIZED", { detail: "Updater signature missing, invalid, or expired" });
  }
  const parsed = updaterReportSchema.safeParse(parseJsonOrNull(body));
  if (!parsed.success) {
    return problemResponse(req, "VALIDATION", { errors: fieldErrors(parsed.error) });
  }
  const desired = await receiveUpdaterReport(parsed.data);
  return NextResponse.json(desired, {
    headers: {
      "Cache-Control": "no-store",
      [UPDATER_HEADER]: signUpdaterBody(key, JSON.stringify(desired), Date.now(), "response"),
    },
  });
}
