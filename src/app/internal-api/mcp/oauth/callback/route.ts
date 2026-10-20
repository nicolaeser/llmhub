import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { isActionFail, runAction } from "@/lib/http/action-result";
import { completeMcpOAuth } from "@/lib/mcp/server-oauth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const result = await runAction(() =>
    completeMcpOAuth({
      code: params.get("code") ?? "",
      state: params.get("state") ?? "",
      iss: params.get("iss"),
      error: params.get("error") ?? "",
    }),
  );
  const target = new URL("/mcp", env.NEXT_PUBLIC_APP_URL);
  if (isActionFail(result)) {
    target.searchParams.set("oauth", "failed");
    target.searchParams.set("reason", result.error);
  } else {
    target.searchParams.set("oauth", "connected");
    target.searchParams.set("server", result.server.id);
  }
  return NextResponse.redirect(target);
}
