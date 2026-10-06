import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { pageItems } from "@/lib/gateway/responses";
import { loadStoredResponse } from "@/lib/gateway/responses-store";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const stored = await loadStoredResponse(id, principal);
    const query = new URL(req.url).searchParams;
    return NextResponse.json(
      pageItems(stored.input, {
        after: query.get("after"),
        limit: query.get("limit"),
        order: query.get("order"),
      }),
    );
  } catch (err) {
    return gateResponse(err, req);
  }
}
