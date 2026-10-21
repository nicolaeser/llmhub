import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { companyOf } from "@/lib/auth/scope";
import { env } from "@/lib/env";
import { readForm } from "@/lib/http/api";
import { problemFromError, problemResponse } from "@/lib/http/problem";
import { draftMcpServer } from "@/lib/mcp/builder";
import { McpSourceError } from "@/lib/mcp/errors";
import { managesMcp } from "@/lib/mcp/scope";
import { parseJsonOrNull } from "@/lib/utils/json";
import { MAX_BUILDER_REQUEST_BYTES } from "@/schemas/mcp";
import type { McpBuilderUpload } from "@/types/mcp";

export const maxDuration = 300;

async function uploadsOf(form: FormData): Promise<McpBuilderUpload[]> {
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  return Promise.all(files.map(async (file) => ({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) })));
}

export async function POST(req: Request) {
  if (!isSameOriginRequest(req.headers, env.NEXT_PUBLIC_APP_URL)) {
    return problemResponse(req, "FORBIDDEN", { detail: "cross-site request rejected" });
  }
  const session = await getSession();
  if (session.error) return problemResponse(req, "UNAUTHORIZED");
  if (!managesMcp(session)) return problemResponse(req, "FORBIDDEN");
  if (companyOf(session)) return problemResponse(req, "PLATFORM_ONLY");
  try {
    const form = await readForm(req, MAX_BUILDER_REQUEST_BYTES);
    const request = form.get("request");
    const draft = await draftMcpServer(typeof request === "string" ? parseJsonOrNull(request) : null, await uploadsOf(form));
    return NextResponse.json(draft, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof McpSourceError) {
      return problemResponse(req, err.message, { errors: [{ pointer: err.pointer, detail: err.message }] });
    }
    return problemFromError(req, err);
  }
}
