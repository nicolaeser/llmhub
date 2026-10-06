import "server-only";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { hasPerm } from "@/lib/auth/permissions";
import { isActionFail } from "@/lib/http/action-result";
import { readJSON } from "@/lib/http/api";
import { ApiProblem, fieldErrors, problemFromError } from "@/lib/http/problem";
import { authenticateManagementKey } from "@/lib/management/auth";
import type { ActionFail } from "@/types/actions";
import type { Permission } from "@/types/auth";
import type { ManagementHandler, ManagementRouteContext } from "@/types/management";

const MAX_BODY_BYTES = 1024 * 1024;
const NO_STORE = { "cache-control": "no-store" };

export function managementRoute<P = Record<string, never>>(
  permission: Permission | null,
  handler: ManagementHandler<P>,
) {
  return async (req: Request, ctx: ManagementRouteContext<P>): Promise<Response> => {
    try {
      const principal = await authenticateManagementKey(req);
      if (permission && !hasPerm(principal.permissions, permission)) {
        throw new ApiProblem("FORBIDDEN", `this key needs the ${permission} permission`);
      }
      const params = await ctx.params;
      return await runAsPrincipal(principal, () => handler({ req, principal, params }));
    } catch (err) {
      return problemFromError(req, err);
    }
  };
}

export async function readBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (type && !type.toLowerCase().includes("json")) {
    throw new ApiProblem("UNSUPPORTED_MEDIA_TYPE", "send the body as application/json");
  }
  let raw: unknown;
  try {
    raw = await readJSON(req, MAX_BODY_BYTES);
  } catch (err) {
    if ((err as { status?: number }).status === 413) throw new ApiProblem("PAYLOAD_TOO_LARGE");
    throw new ApiProblem("INVALID_JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

export function readQuery<T>(req: Request, schema: ZodType<T>): T {
  const params = new URL(req.url).searchParams;
  const parsed = schema.safeParse(Object.fromEntries(params.entries()));
  if (!parsed.success) {
    throw new ApiProblem("INVALID_PARAMETER", "one or more query parameters are invalid", {
      errors: fieldErrors(parsed.error, "query"),
    });
  }
  return parsed.data;
}

export function unwrap<T>(result: T | ActionFail): T {
  if (isActionFail(result)) throw new Error(result.error);
  return result;
}

export function respond(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function respondList<T>(data: T[], extra: Record<string, unknown> = {}): NextResponse {
  return respond({ object: "list", data, ...extra });
}

export function notFound(what: string): ApiProblem {
  return new ApiProblem("NOT_FOUND", `${what} not found`);
}
