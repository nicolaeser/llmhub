import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { env } from "@/lib/env";
import { assertContentLength, MAX_UPLOAD_BYTES } from "@/lib/http/api";
import { problemFromError, problemResponse } from "@/lib/http/problem";
import { uploadConsoleFile } from "@/lib/rag/console";

export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(req.headers, env.NEXT_PUBLIC_APP_URL)) {
    return problemResponse(req, "FORBIDDEN", { detail: "cross-site request rejected" });
  }
  const session = await getSession();
  if (session.error) return problemResponse(req, "UNAUTHORIZED");
  if (!hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE)) return problemResponse(req, "FORBIDDEN");
  try {
    assertContentLength(req, MAX_UPLOAD_BYTES);
    const { id } = await ctx.params;
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) {
      return problemResponse(req, "VALIDATION", { detail: "file is required" });
    }
    if (file.size > MAX_UPLOAD_BYTES) return problemResponse(req, "PAYLOAD_TOO_LARGE");
    const result = await uploadConsoleFile(session, id, {
      filename: file.name || "upload.bin",
      contentType: file.type,
      payload: new Uint8Array(await file.arrayBuffer()),
    });
    return NextResponse.json(result);
  } catch (err) {
    return problemFromError(req, err);
  }
}
