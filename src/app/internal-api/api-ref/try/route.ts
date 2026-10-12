import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { readJSON } from "@/lib/http/api";
import { problemResponse } from "@/lib/http/problem";
import { asRecord, asString } from "@/lib/gateway/core";
import { ANTHROPIC_VERSION, resolveTryTarget } from "@/lib/gateway/openapi";
import { gatewayPath } from "@/lib/gateway/route-pool";
import { mintTryBearer } from "@/lib/gateway/try-bearer";
import type { JsonMap } from "@/types/gateway";
import { env } from "@/lib/env";

export const maxDuration = 300;

const MAX_BODY_CHARS = 256_000;
const MAX_RESPONSE_BYTES = 1_000_000;

function paramMap(value: unknown): Record<string, string> {
  const rec = asRecord(value);
  if (!rec) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(rec)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

export async function POST(req: Request) {
  if (!isSameOriginRequest(req.headers, env.NEXT_PUBLIC_APP_URL)) {
    return problemResponse(req, "FORBIDDEN", { detail: "cross-site request rejected" });
  }
  const session = await getSession();
  if (session.error) return problemResponse(req, "UNAUTHORIZED");
  if (!hasPerm(session.permissions, PERMISSIONS.PLAYGROUND_USE) || session.user.blocked) {
    return problemResponse(req, "FORBIDDEN");
  }

  let payload: JsonMap;
  try {
    payload = await readJSON<JsonMap>(req);
  } catch (err) {
    if ((err as { status?: number }).status === 413) return problemResponse(req, "PAYLOAD_TOO_LARGE");
    return problemResponse(req, "INVALID_JSON");
  }

  const method = asString(payload.method).toUpperCase();
  const templatePath = asString(payload.path);
  const body = asString(payload.body);
  if (body.length > MAX_BODY_CHARS) {
    return problemResponse(req, "PAYLOAD_TOO_LARGE");
  }

  const target = resolveTryTarget(method, templatePath, paramMap(payload.params));
  if (!target.ok) return problemResponse(req, target.error);

  const origin = new URL(env.NEXT_PUBLIC_APP_URL).origin;
  const url = new URL(target.path, origin);
  if (url.origin !== origin || !gatewayPath(url.pathname).startsWith("/v1/")) {
    return problemResponse(req, "INVALID_PATH");
  }

  const bearer = mintTryBearer(session.user.id);
  const headers = new Headers(
    payload.format === "anthropic"
      ? { "x-api-key": bearer, "anthropic-version": ANTHROPIC_VERSION, Accept: "*/*" }
      : { Authorization: `Bearer ${bearer}`, Accept: "*/*" },
  );
  const hasBody = target.method !== "GET" && target.method !== "DELETE" && body.length > 0;
  if (hasBody) headers.set("Content-Type", "application/json");

  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: target.method,
      headers,
      body: hasBody ? body : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return problemResponse(req, "UPSTREAM_FAILED", { detail: "the gateway did not respond" });
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  const bytes = buf.byteLength;
  const contentType = upstream.headers.get("content-type") ?? "";
  const isText =
    !contentType ||
    contentType.includes("json") ||
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("event-stream");
  return NextResponse.json({
    status: upstream.status,
    latencyMs: Date.now() - started,
    contentType,
    bytes,
    binary: !isText && bytes > 0,
    body: isText ? buf.subarray(0, MAX_RESPONSE_BYTES).toString("utf8") : "",
  });
}
