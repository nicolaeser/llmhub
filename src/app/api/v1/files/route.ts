import { NextResponse } from "next/server";
import { gateRequest, gateResponse, readBody } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { fileJson, listObjects, putObject } from "@/lib/gateway/objects";
import { ownerId } from "@/lib/gateway/core";
import { assertContentLength, MAX_UPLOAD_BYTES } from "@/lib/http/api";

export async function GET(req: Request) {
  try {
    const principal = await gateRequest(req);
    const owner = ownerId(principal);
    const files = await listObjects("file", owner);
    return NextResponse.json({ object: "list", data: files.map(fileJson) });
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const ct = req.headers.get("content-type") ?? "";
    let filename = "upload.bin";
    let purpose = "assistants";
    let contentType = "";
    let payload = Buffer.alloc(0);
    if (ct.includes("multipart/form-data")) {
      assertContentLength(req, MAX_UPLOAD_BYTES);
      const form = await req.formData();
      purpose = String(form.get("purpose") ?? purpose);
      const file = form.get("file");
      if (!(file && typeof file === "object" && "arrayBuffer" in file)) {
        throw new GateError(400, "missing_required_parameter", "file is required", { param: "file" });
      }
      const blob = file as File;
      filename = blob.name || filename;
      contentType = blob.type;
      payload = Buffer.from(await blob.arrayBuffer());
    } else {
      const body = await readBody(req);
      filename = typeof body.filename === "string" ? body.filename : filename;
      purpose = typeof body.purpose === "string" ? body.purpose : purpose;
      if (typeof body.content_b64 === "string") {
        payload = Buffer.from(body.content_b64, "base64");
      } else if (typeof body.content === "string") {
        payload = Buffer.from(body.content);
      }
    }
    const stored = await putObject({
      kind: "file",
      owner: ownerId(principal),
      filename,
      purpose,
      contentType,
      payload,
    });
    return NextResponse.json(fileJson(stored));
  } catch (err) {
    return gateResponse(err, req);
  }
}
