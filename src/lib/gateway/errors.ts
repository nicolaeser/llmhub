import type {
  AnthropicErrorBody,
  AnthropicErrorType,
  GateErrorOptions,
  GatewayErrorCode,
  GatewayErrorType,
  OpenAIErrorBody,
} from "@/types/errors";

export const GATEWAY_ERRORS = {
  invalid_json: 400,
  invalid_request: 400,
  missing_required_parameter: 400,
  unsupported_parameter: 400,
  unsupported_endpoint: 400,
  pii_blocked: 400,
  guardrail_blocked: 400,
  cost_limit_exceeded: 400,
  file_not_found: 400,
  previous_response_not_found: 400,
  invalid_api_key: 401,
  permission_denied: 403,
  ip_not_allowed: 403,
  endpoint_not_allowed: 403,
  outside_access_window: 403,
  model_access_denied: 403,
  model_not_found: 404,
  not_found: 404,
  batch_not_cancellable: 409,
  payload_too_large: 413,
  rate_limit_exceeded: 429,
  budget_exceeded: 429,
  internal_error: 500,
  upstream_error: 502,
  no_healthy_deployment: 503,
  no_provider_key: 503,
  upstream_timeout: 504,
} as const satisfies Record<string, number>;

export class GateError extends Error {
  readonly code: string;
  readonly param: string | null;
  readonly retryAt: number | null;

  constructor(
    readonly status: number,
    code: GatewayErrorCode,
    message: string,
    options: GateErrorOptions = {},
  ) {
    super(message);
    this.name = "GateError";
    this.code = options.upstreamCode || code;
    this.param = options.param ?? null;
    this.retryAt = options.retryAt ?? null;
  }

  get type(): GatewayErrorType {
    return gatewayErrorType(this.status, this.code);
  }
}

export function gatewayErrorType(status: number, code: string): GatewayErrorType {
  if (code === "budget_exceeded") return "insufficient_quota";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

export function anthropicErrorType(status: number): AnthropicErrorType {
  if (status === 401) return "authentication_error";
  if (status === 402) return "billing_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 504) return "timeout_error";
  if (status === 503 || status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

export function openAIErrorBody(err: GateError): OpenAIErrorBody {
  return {
    error: { message: err.message, type: err.type, param: err.param, code: err.code },
  };
}

export function anthropicErrorBody(
  status: number,
  message: string,
  requestId?: string,
): AnthropicErrorBody {
  return {
    type: "error",
    error: { type: anthropicErrorType(status), message },
    ...(requestId ? { request_id: requestId } : {}),
  };
}
