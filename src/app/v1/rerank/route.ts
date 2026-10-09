import { NextResponse } from "next/server";
import { gateRequest, gateResponse, modelOf, readBody } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { parseRequest } from "@/lib/gateway/responses";
import { forwardModelCall, RERANK_PATH, rerankUsage } from "@/lib/rag/models";
import { rerankRequestSchema } from "@/schemas/rag";

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const body = await readBody(req);
    const parsed = parseRequest(rerankRequestSchema, body);
    if (!parsed.ok) throw new GateError(400, "invalid_request", parsed.message, { param: parsed.param });
    const hit = await forwardModelCall({
      principal,
      model: modelOf(body),
      path: RERANK_PATH,
      body,
      usage: rerankUsage,
    });
    return NextResponse.json(hit.json);
  } catch (err) {
    return gateResponse(err, req);
  }
}
