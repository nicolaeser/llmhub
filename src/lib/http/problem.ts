import "server-only";

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "@/lib/auth/errors";
import { env } from "@/lib/env";
import { newRequestId, routerGateError } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { isActionCode } from "@/lib/http/action-result";
import { isPayloadTooLarge } from "@/lib/http/api";
import { normalizeProblemCode, problemSpec } from "@/lib/http/problem-codes";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type { ActionFail } from "@/types/actions";
import type {
  ProblemCode,
  ProblemDetails,
  ProblemFieldError,
  ProblemOptions,
} from "@/types/errors";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export class ApiProblem extends Error {
  constructor(
    readonly code: ProblemCode,
    detail?: string,
    readonly options: ProblemOptions = {},
  ) {
    super(detail ?? problemSpec(code).title);
    this.name = "ApiProblem";
  }
}

export function problemType(code: string): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/api-ref#error-${code}`;
}

function escapePointer(segment: PropertyKey): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

export function fieldErrors(error: ZodError, location: "body" | "query" = "body"): ProblemFieldError[] {
  const located = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => ({ path: [...issue.path, key], detail: `unknown field "${key}"` }))
      : [{ path: issue.path, detail: issue.message }],
  );
  return located.slice(0, 20).map(({ path, detail }) =>
    location === "query"
      ? { parameter: path.map(String).join("."), detail }
      : { pointer: `#/${path.map(escapePointer).join("/")}`, detail },
  );
}

export function problemResponse(
  req: Request,
  code: string,
  input: ProblemOptions & { status?: number; detail?: string; cause?: unknown } = {},
): NextResponse {
  const normalized = normalizeProblemCode(code);
  const spec = problemSpec(normalized, input.status);
  const requestId = newRequestId();
  const body: ProblemDetails = {
    type: problemType(normalized),
    title: spec.title,
    status: spec.status,
    detail: input.detail || spec.title,
    instance: new URL(req.url).pathname,
    code: normalized,
    request_id: requestId,
    ...(input.errors?.length ? { errors: input.errors } : {}),
  };
  if (spec.status >= 500) {
    logger.error("api.problem", {
      requestId,
      path: body.instance,
      code: normalized,
      ...(input.cause === undefined ? {} : errorFields(input.cause)),
    });
  }
  return NextResponse.json(body, {
    status: spec.status,
    headers: {
      ...input.headers,
      "content-type": PROBLEM_CONTENT_TYPE,
      "x-request-id": requestId,
    },
  });
}

export function actionProblem(req: Request, fail: ActionFail): NextResponse {
  return problemResponse(req, fail.error);
}

export function problemFromError(req: Request, err: unknown): NextResponse {
  if (err instanceof ApiProblem) {
    return problemResponse(req, err.code, { ...err.options, detail: err.message });
  }
  const gate = err instanceof GateError ? err : routerGateError(err);
  if (gate) {
    return problemResponse(req, gate.code.toUpperCase(), {
      status: gate.status,
      detail: gate.message,
      cause: err,
    });
  }
  if (err instanceof AuthError) return problemResponse(req, err.code);
  if (err instanceof ZodError) {
    return problemResponse(req, "VALIDATION", { errors: fieldErrors(err) });
  }
  if (isPayloadTooLarge(err)) return problemResponse(req, "PAYLOAD_TOO_LARGE");
  if (err instanceof Error && isActionCode(err.message)) {
    return problemResponse(req, err.message);
  }
  return problemResponse(req, "INTERNAL_ERROR", { cause: err });
}
