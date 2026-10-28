import { NextRequest, NextResponse } from "next/server";
import { backchannelLogout } from "@/lib/auth/sso-sessions";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { readTextOr } from "@/lib/utils/json";

export const dynamic = "force-dynamic";

const MAX_LOGOUT_REQUEST_BYTES = 16_384;
const NO_STORE = { "Cache-Control": "no-store" };

function invalid() {
  return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_LOGOUT_REQUEST_BYTES) return invalid();
  const body = await readTextOr(req);
  if (body.length > MAX_LOGOUT_REQUEST_BYTES) return invalid();
  const logoutToken = new URLSearchParams(body).get("logout_token") ?? "";
  if (!logoutToken) return invalid();
  try {
    const ended = await backchannelLogout(logoutToken);
    logger.info("sso.backchannel_logout", { ended });
    return new NextResponse(null, { status: 200, headers: NO_STORE });
  } catch (err) {
    logger.warn("sso.backchannel_logout_rejected", errorFields(err));
    return invalid();
  }
}
