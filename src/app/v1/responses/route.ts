import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { listObjects, payloadJson } from "@/lib/gateway/objects";
import { storedResponse, visibleResponse } from "@/lib/gateway/responses";
import { createResponseRoute } from "@/lib/gateway/responses-route";
import { ownerId } from "@/lib/gateway/core";

export const maxDuration = 300;

export async function GET(req: Request) {
  try {
    const principal = await gateRequest(req);
    const owner = ownerId(principal);
    const items = await listObjects("response", owner);
    return NextResponse.json({
      object: "list",
      data: items.map((item) => visibleResponse(storedResponse(item.id, payloadJson(item)).response, null)),
    });
  } catch (err) {
    return gateResponse(err, req);
  }
}

export const POST = createResponseRoute("api");
