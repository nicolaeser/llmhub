import type { ProblemCode, ProblemSpec } from "@/types/errors";

export const PROBLEMS = {
  BAD_REQUEST: { status: 400, title: "Bad request" },
  INVALID_JSON: { status: 400, title: "Request body must be valid JSON" },
  INVALID_PARAMETER: { status: 400, title: "Invalid query or path parameter" },
  MISSING_ID: { status: 400, title: "Missing identifier" },
  MISSING_PARAM: { status: 400, title: "Missing path parameter" },
  INVALID_PATH: { status: 400, title: "Invalid request path" },
  INVALID_TOKEN: { status: 400, title: "Invalid or expired token" },
  UNKNOWN_ENTITY_TYPE: { status: 400, title: "Unknown budget entity type" },
  ENTITY_REQUIRED: { status: 400, title: "Budget entity required" },
  UNAUTHORIZED: { status: 401, title: "Authentication required" },
  INVALID_API_KEY: { status: 401, title: "Invalid API key" },
  FORBIDDEN: { status: 403, title: "Permission denied" },
  PLATFORM_ONLY: { status: 403, title: "Only platform users can change this" },
  INVALID_SCOPE: { status: 403, title: "Requested permissions exceed your own" },
  SIGN_IN_DENIED: { status: 403, title: "Provider sign-in was declined" },
  SETUP_REQUIRED: { status: 403, title: "First administrator setup required" },
  REGISTRATION_DISABLED: { status: 403, title: "Registration is disabled" },
  NOT_FOUND: { status: 404, title: "Resource not found" },
  USER_NOT_FOUND: { status: 404, title: "User not found" },
  UNKNOWN_ENDPOINT: { status: 404, title: "Unknown endpoint" },
  RESET_DISABLED: { status: 404, title: "Password reset is disabled" },
  CONFLICT: { status: 409, title: "Conflict with current state" },
  SIGN_IN_EXPIRED: { status: 409, title: "Provider sign-in expired; sign in again in the console" },
  ALIAS_EXISTS: { status: 409, title: "Alias already exists" },
  PROVIDER_IN_USE: { status: 409, title: "Provider is used by deployments" },
  TEMPLATE_IN_USE: { status: 409, title: "Model template is used by API keys" },
  NAME_EXISTS: { status: 409, title: "Name already exists" },
  HAS_CHILDREN: { status: 409, title: "Remove or move nested items first" },
  USER_EXISTS: { status: 409, title: "User already exists" },
  MEMBER_EXISTS: { status: 409, title: "A person with this email already exists in the company" },
  PAYLOAD_TOO_LARGE: { status: 413, title: "Request body is too large" },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: "Unsupported media type" },
  VALIDATION: { status: 422, title: "Validation failed" },
  ALIAS_REQUIRED: { status: 422, title: "Alias required" },
  ALIAS_RESERVED: { status: 422, title: "Alias is reserved" },
  PRICE_WINDOWS_OVERLAP: { status: 422, title: "Price windows overlap" },
  TEAM_NOT_FOUND: { status: 422, title: "Referenced department not found" },
  ORG_NOT_FOUND: { status: 422, title: "Referenced company not found" },
  PROJECT_NOT_FOUND: { status: 422, title: "Referenced project not found" },
  MEMBER_NOT_FOUND: { status: 422, title: "Referenced person not found" },
  TEAM_NOT_IN_ORG: { status: 422, title: "Department belongs to another company" },
  ORG_REQUIRED: { status: 422, title: "Company required" },
  ORG_LOCKED: { status: 422, title: "The company of an existing department, project, or person cannot change" },
  KEY_BINDING_CONFLICT: { status: 422, title: "Bind a key to one project or one person" },
  TEMPLATE_NOT_FOUND: { status: 422, title: "Referenced model template not found" },
  TEMPLATE_EMPTY: { status: 422, title: "Model template needs a rule or model" },
  BUDGET_EXCEEDS_PARENT: { status: 422, title: "Budget exceeds a parent budget" },
  BUDGET_NOT_CAPPED: { status: 422, title: "Set a budget before adding a temporary boost" },
  UNKNOWN_PROVIDER_KIND: { status: 422, title: "Unknown provider kind" },
  INVALID_URL: { status: 422, title: "Invalid URL" },
  SIGN_IN_REQUIRED: { status: 422, title: "This provider connects by signing in from the console" },
  WEAK_PASSWORD: { status: 422, title: "Password is too weak" },
  PASSWORD_GUESSABLE: { status: 422, title: "Password is too easy to guess" },
  PASSWORD_REUSED: { status: 422, title: "Password was used before" },
  RATE_LIMITED: { status: 429, title: "Too many requests" },
  INTERNAL_ERROR: { status: 500, title: "Internal server error" },
  UPSTREAM_FAILED: { status: 502, title: "Upstream request failed" },
  UPSTREAM_EMPTY: { status: 502, title: "Upstream returned no models" },
  SIGN_IN_FAILED: { status: 502, title: "Provider sign-in failed" },
  SERVICE_UNAVAILABLE: { status: 503, title: "Service unavailable" },
} as const satisfies Record<string, ProblemSpec>;

const STATUS_TITLES: Record<number, string> = {
  400: "Bad request",
  401: "Authentication required",
  402: "Payment required",
  403: "Permission denied",
  404: "Resource not found",
  405: "Method not allowed",
  409: "Conflict with current state",
  413: "Request body is too large",
  415: "Unsupported media type",
  422: "Validation failed",
  429: "Too many requests",
  500: "Internal server error",
  502: "Upstream request failed",
  503: "Service unavailable",
  504: "Upstream timed out",
};

const ACTION_ALIASES: Record<string, ProblemCode> = {
  Unauthorized: "UNAUTHORIZED",
  Forbidden: "FORBIDDEN",
  REQUEST_FAILED: "INTERNAL_ERROR",
};

export function isProblemCode(code: string): code is ProblemCode {
  return Object.hasOwn(PROBLEMS, code);
}

export function normalizeProblemCode(code: string): string {
  return ACTION_ALIASES[code] ?? code;
}

export function statusTitle(status: number): string {
  return STATUS_TITLES[status] ?? (status >= 500 ? "Internal server error" : "Bad request");
}

export function problemSpec(code: string, status?: number): ProblemSpec {
  if (isProblemCode(code)) {
    const spec = PROBLEMS[code];
    return status && status !== spec.status ? { status, title: statusTitle(status) } : spec;
  }
  const resolved = status ?? 400;
  return { status: resolved, title: statusTitle(resolved) };
}
