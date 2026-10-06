import type { GATEWAY_ERRORS } from "@/lib/gateway/errors";
import type { PROBLEMS } from "@/lib/http/problems";

export type GatewayErrorCode = keyof typeof GATEWAY_ERRORS;

export type GatewayErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "insufficient_quota"
  | "api_error";

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "timeout_error"
  | "overloaded_error";

export type GateErrorOptions = {
  param?: string | null;
  upstreamCode?: string;
};

export type OpenAIErrorBody = {
  error: {
    message: string;
    type: GatewayErrorType;
    param: string | null;
    code: string;
  };
};

export type AnthropicErrorBody = {
  type: "error";
  error: { type: AnthropicErrorType; message: string };
  request_id?: string;
};

export type ProblemCode = keyof typeof PROBLEMS;

export type ProblemSpec = { status: number; title: string };

export type ProblemFieldError = {
  pointer?: string;
  parameter?: string;
  detail: string;
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  request_id: string;
  errors?: ProblemFieldError[];
};

export type ProblemOptions = {
  errors?: ProblemFieldError[];
  headers?: Record<string, string>;
};
