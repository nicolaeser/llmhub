import "server-only";
import { readBody } from "@/lib/gateway/gate";
import { assertContentLength, MAX_UPLOAD_BYTES } from "@/lib/http/api";
import type { JsonMap } from "@/types/gateway";

export async function readModelRequest(
  req: Request,
): Promise<{ body: JsonMap; rawBody?: FormData; contentType: string }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) return { body: await readBody(req), contentType };
  assertContentLength(req, MAX_UPLOAD_BYTES);
  const form = await req.formData();
  const body: JsonMap = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") body[key] = value;
  }
  return { body, rawBody: form, contentType };
}
