import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { gateRequest, gateResponse, modelPermitted } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { apiKeyRequest } from "@/lib/gateway/messages";
import { modelEntry } from "@/lib/gateway/core";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await gateRequest(apiKeyRequest(req));
    const { id } = await ctx.params;
    const exists =
      id === "auto" || Boolean(await prisma.modelGroup.findUnique({ where: { alias: id }, select: { alias: true } }));
    if (!exists || !modelPermitted(principal, id)) {
      throw new GateError(404, "model_not_found", "model not found", { param: "id" });
    }
    return NextResponse.json(modelEntry(id, new Date()));
  } catch (err) {
    return gateResponse(err, req);
  }
}
