import { z } from "zod";

export const MCP_SCOPES = ["org", "team", "project", "member", "key"] as const;
export const MCP_AUTH_TYPES = ["none", "bearer", "header"] as const;
export const MCP_MODES = ["allow", "block"] as const;
export const MAX_MCP_ASSIGNMENTS = 500;

const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
  "upgrade",
]);

const toolNames = z.array(z.string().trim().min(1).max(128)).max(200);

const connectionShape = {
  url: z.string().trim().min(1).max(2048),
  authType: z.enum(MCP_AUTH_TYPES),
  authHeader: z.string().trim().max(64),
  secret: z
    .string()
    .max(4096)
    .refine((value) => ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127), {
      message: "invalid characters",
    }),
  internal: z.boolean(),
};

function checkHeader(value: { authType: string; authHeader: string }, ctx: z.RefinementCtx) {
  if (value.authType !== "header") return;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value.authHeader) || RESERVED_HEADERS.has(value.authHeader.toLowerCase())) {
    ctx.addIssue({ code: "custom", path: ["authHeader"], message: "invalid header name" });
  }
}

export const mcpServerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(48),
    description: z.string().trim().max(500),
    ...connectionShape,
    clearSecret: z.boolean(),
    enabled: z.boolean(),
    global: z.boolean(),
    toolsRestricted: z.boolean(),
    allowedTools: toolNames,
  })
  .superRefine(checkHeader);

export const mcpProbeSchema = z
  .object({
    id: z.string().max(64).optional(),
    ...connectionShape,
  })
  .superRefine(checkHeader);

export const mcpAssignmentsSchema = z.object({
  serverId: z.string().min(1).max(64),
  global: z.boolean(),
  assignments: z
    .array(
      z.object({
        scope: z.enum(MCP_SCOPES),
        id: z.string().min(1).max(64),
        mode: z.enum(MCP_MODES),
        blockedTools: toolNames,
      }),
    )
    .max(MAX_MCP_ASSIGNMENTS),
});
