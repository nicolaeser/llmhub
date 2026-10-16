import { z } from "zod";

export const BUILDER_MODEL_KEY = "mcp_builder_model";
export const MCP_SCOPES = ["org", "team", "project", "member", "key"] as const;
export const MCP_ACTIONS = ["read", "write", "delete"] as const;
export const MCP_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const MCP_AUTH_TYPES = ["none", "bearer", "header", "oauth"] as const;
export const MCP_OAUTH_GRANTS = ["authorization_code", "client_credentials"] as const;
export const MCP_MODES = ["allow", "block"] as const;
export const MCP_ROLE_KEYS = ["reader", "operator", "admin"] as const;
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
const actions = z.array(z.enum(MCP_ACTIONS)).max(MCP_ACTIONS.length);

const PATH_PARAM = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

export const hostedToolSchema = z
  .object({
    name: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    title: z.string().trim().max(200).default(""),
    description: z.string().trim().max(2000).default(""),
    action: z.enum(MCP_ACTIONS),
    method: z.enum(MCP_HTTP_METHODS),
    path: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^\/(?!\/)(?!.*\.\.)[A-Za-z0-9._~{}:/-]*$/),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((tool, ctx) => {
    if (JSON.stringify(tool.inputSchema).length > 32_000) {
      ctx.addIssue({ code: "custom", path: ["inputSchema"], message: "schema too large" });
    }
    const properties =
      tool.inputSchema.properties && typeof tool.inputSchema.properties === "object"
        ? (tool.inputSchema.properties as Record<string, unknown>)
        : {};
    for (const match of tool.path.matchAll(PATH_PARAM)) {
      if (!properties[match[1]!]) ctx.addIssue({ code: "custom", path: ["path"], message: "missing path parameter" });
    }
  });

export const mcpDraftBaseSchema = z.object({
  name: z.string().trim().min(1).max(48),
  description: z.string().trim().max(500).default(""),
  baseUrl: z.string().trim().min(1).max(2048),
  internal: z.boolean().default(false),
  authType: z.enum(["none", "bearer", "header"]).default("none"),
  authHeader: z.string().trim().max(64).default(""),
  notes: z.string().trim().max(2000).default(""),
});

export const builderModelSchema = z.string().trim().max(200);

export const builderDraftSchema = z.object({
  instruction: z.string().trim().min(1).max(2_000),
  docs: z.string().trim().min(1).max(60_000),
});

export const hostedServerSchema = z
  .object({
    name: z.string().trim().min(1).max(48),
    description: z.string().trim().max(500),
    baseUrl: z.string().trim().min(1).max(2048),
    internal: z.boolean(),
    authType: z.enum(["none", "bearer", "header"]),
    authHeader: z.string().trim().max(64).default(""),
    secret: z
      .string()
      .max(4096)
      .default("")
      .refine((value) => ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127), {
        message: "invalid characters",
      }),
    tools: z.array(hostedToolSchema).min(1).max(30),
    template: z.boolean().default(false),
    global: z.boolean().default(false),
    assignments: z
      .array(
        z.object({
          scope: z.enum(MCP_SCOPES),
          id: z.string().min(1).max(64),
          mode: z.enum(MCP_MODES),
          blockedTools: toolNames,
          blockedActions: actions.default([]),
          roleKey: z.enum(["", ...MCP_ROLE_KEYS]).default(""),
        }),
      )
      .max(MAX_MCP_ASSIGNMENTS)
      .default([]),
  })
  .superRefine((value, ctx) => {
    if (value.authType === "header" && !/^[A-Za-z0-9-]{1,64}$/.test(value.authHeader)) {
      ctx.addIssue({ code: "custom", path: ["authHeader"], message: "invalid header name" });
    }
    if (value.authType !== "none" && !value.secret.trim()) {
      ctx.addIssue({ code: "custom", path: ["secret"], message: "secret required" });
    }
  });

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
  oauthGrant: z.enum(MCP_OAUTH_GRANTS).default("authorization_code"),
  oauthClientId: z
    .string()
    .trim()
    .max(512)
    .regex(/^[\x21-\x7E]*$/)
    .default(""),
  oauthScopes: z
    .string()
    .trim()
    .max(1024)
    .regex(/^[\x21\x23-\x5B\x5D-\x7E ]*$/)
    .default(""),
};

function checkConnection(
  value: { authType: string; authHeader: string; oauthGrant: string; oauthClientId: string },
  ctx: z.RefinementCtx,
) {
  if (value.authType === "header") {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(value.authHeader) || RESERVED_HEADERS.has(value.authHeader.toLowerCase())) {
      ctx.addIssue({ code: "custom", path: ["authHeader"], message: "invalid header name" });
    }
  }
  if (value.authType === "oauth" && value.oauthGrant === "client_credentials" && !value.oauthClientId) {
    ctx.addIssue({ code: "custom", path: ["oauthClientId"], message: "client id required" });
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
  .superRefine(checkConnection);

export const mcpProbeSchema = z
  .object({
    id: z.string().max(64).optional(),
    ...connectionShape,
  })
  .superRefine(checkConnection);

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
        blockedActions: actions.default([]),
        roleId: z.string().max(64).default(""),
      }),
    )
    .max(MAX_MCP_ASSIGNMENTS),
});

export const MAX_MCP_ROLES = 50;

export const mcpPermissionsSchema = z.object({
  serverId: z.string().min(1).max(64),
  toolActions: z
    .record(z.string().trim().min(1).max(128), z.enum(MCP_ACTIONS))
    .refine((value) => Object.keys(value).length <= 200, { message: "too many tools" }),
  roles: z
    .array(
      z.object({
        id: z.string().max(64).default(""),
        name: z.string().trim().min(1).max(48),
        description: z.string().trim().max(200).default(""),
        allActions: z.boolean(),
        actions: actions.default([]),
        tools: toolNames.default([]),
        deniedTools: toolNames.default([]),
      }),
    )
    .max(MAX_MCP_ROLES),
  removed: z.array(z.string().min(1).max(64)).max(MAX_MCP_ROLES).default([]),
});

export const mcpInstallationSchema = z
  .object({
    serverId: z.string().min(1).max(64),
    orgId: z.string().min(1).max(64),
    enabled: z.boolean(),
    baseUrl: z.string().trim().max(2048).default(""),
    authType: z.enum(["none", "bearer", "header"]),
    authHeader: z.string().trim().max(64).default(""),
    secret: z
      .string()
      .max(4096)
      .default("")
      .refine((value) => ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127), {
        message: "invalid characters",
      }),
  })
  .superRefine((value, ctx) => {
    if (value.baseUrl && !/^https?:\/\//.test(value.baseUrl)) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "invalid url" });
    }
    if (value.authType === "header" && !/^[A-Za-z0-9-]{1,64}$/.test(value.authHeader)) {
      ctx.addIssue({ code: "custom", path: ["authHeader"], message: "invalid header name" });
    }
  });

export const mcpTemplateSchema = z.object({
  id: z.string().min(1).max(64),
  template: z.boolean(),
});

export const mcpServerIdSchema = z.string().min(1).max(64);

export const mcpOAuthCallbackSchema = z.object({
  code: z.string().max(4096).default(""),
  state: z.string().max(512).default(""),
  iss: z.string().max(2048).nullable().default(null),
  error: z.string().max(256).default(""),
});
