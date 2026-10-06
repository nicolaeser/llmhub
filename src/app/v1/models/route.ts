import { NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { gateRequest, gateResponse, modelPermitted } from "@/lib/gateway/gate";
import { apiKeyRequest } from "@/lib/gateway/messages";
import { modelEntry } from "@/lib/gateway/core";

export async function GET(req: Request) {
  try {
    const principal = await gateRequest(apiKeyRequest(req));
    const groups = await prisma.modelGroup.findMany({ select: { alias: true } });
    const created = new Date();
    const data = [...groups.map((group) => group.alias), "auto"]
      .filter((alias) => modelPermitted(principal, alias))
      .map((alias) => modelEntry(alias, created));
    return NextResponse.json({
      object: "list",
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
    });
  } catch (err) {
    return gateResponse(err, req);
  }
}
