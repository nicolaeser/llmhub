export const MCP_ERROR_CODES = [
  "MCP_URL_INVALID",
  "MCP_URL_INSECURE",
  "MCP_URL_BLOCKED",
  "MCP_UNREACHABLE",
  "MCP_TIMEOUT",
  "MCP_AUTH_FAILED",
  "MCP_HTTP_ERROR",
  "MCP_PROTOCOL_ERROR",
  "MCP_RPC_ERROR",
  "MCP_RESPONSE_TOO_LARGE",
] as const;

export class McpError extends Error {
  readonly detail: string;

  constructor(
    readonly code: (typeof MCP_ERROR_CODES)[number],
    detail = "",
  ) {
    super(code);
    this.name = "McpError";
    this.detail = detail;
  }
}

export function mcpErrorCode(err: unknown): (typeof MCP_ERROR_CODES)[number] {
  if (err instanceof McpError) return err.code;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "MCP_TIMEOUT";
  return "MCP_UNREACHABLE";
}
