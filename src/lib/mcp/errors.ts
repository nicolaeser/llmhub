import type { McpChallenge } from "@/types/mcp";

export const MCP_ERROR_CODES = [
  "MCP_URL_INVALID",
  "MCP_URL_INSECURE",
  "MCP_URL_BLOCKED",
  "MCP_UNREACHABLE",
  "MCP_TIMEOUT",
  "MCP_AUTH_FAILED",
  "MCP_AUTH_REQUIRED",
  "MCP_AUTH_SCOPE",
  "MCP_OAUTH_SUGGESTED",
  "MCP_OAUTH_DISCOVERY",
  "MCP_OAUTH_UNSUPPORTED",
  "MCP_OAUTH_CLIENT_REQUIRED",
  "MCP_OAUTH_REGISTRATION",
  "MCP_OAUTH_TOKEN",
  "MCP_OAUTH_STATE",
  "MCP_OAUTH_DENIED",
  "MCP_OAUTH_APP_URL",
  "MCP_HTTP_ERROR",
  "MCP_PROTOCOL_ERROR",
  "MCP_VERSION_UNSUPPORTED",
  "MCP_INPUT_REQUIRED",
  "MCP_RPC_ERROR",
  "MCP_RESPONSE_TOO_LARGE",
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export class McpError extends Error {
  readonly detail: string;
  readonly challenge: McpChallenge | null;
  readonly rpcCode: number | null;

  constructor(code: McpErrorCode, detail = "", extra: { challenge?: McpChallenge | null; rpcCode?: number | null } = {}) {
    super(code);
    this.name = "McpError";
    this.detail = detail;
    this.challenge = extra.challenge ?? null;
    this.rpcCode = extra.rpcCode ?? null;
  }

  get code(): McpErrorCode {
    return this.message as McpErrorCode;
  }
}

export class McpSourceError extends Error {
  constructor(
    code: string,
    readonly pointer: string,
  ) {
    super(code);
    this.name = "McpSourceError";
  }
}

export function mcpErrorCode(err: unknown): McpErrorCode {
  if (err instanceof McpError) return err.code;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "MCP_TIMEOUT";
  return "MCP_UNREACHABLE";
}
