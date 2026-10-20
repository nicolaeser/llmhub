import { z } from "zod";

export const BUILDER_MODEL_KEY = "mcp_builder_model";
export const MCP_SCOPES = ["org", "team", "project", "member", "key"] as const;
export const MCP_ACTIONS = ["read", "write", "delete"] as const;
export const MCP_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const MCP_STATIC_AUTH_TYPES = ["none", "bearer", "basic", "header", "query"] as const;
export const MCP_AUTH_TYPES = [...MCP_STATIC_AUTH_TYPES, "oauth"] as const;
export const MCP_OAUTH_GRANTS = ["authorization_code", "client_credentials"] as const;
export const MCP_MODES = ["allow", "block"] as const;
export const MCP_ROLE_KEYS = ["reader", "operator", "admin"] as const;
export const MCP_BUILDER_TEMPLATES = ["readonly", "writes", "full", "custom"] as const;
export const MAX_MCP_ASSIGNMENTS = 500;
export const MAX_HOSTED_TOOLS = 200;
export const MAX_BUILDER_DOCS = 600_000;

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
const AUTH_HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const AUTH_QUERY_NAME = /^[A-Za-z0-9_.~[\]-]{1,64}$/;

function hasControl(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function authUsesName(authType: string): boolean {
  return authType === "header" || authType === "basic" || authType === "query";
}

export function authNameValid(authType: string, value: string): boolean {
  const name = value.trim();
  if (authType === "header") return AUTH_HEADER_NAME.test(name);
  if (authType === "basic") return name.length > 0 && name.length <= 64 && !name.includes(":") && !hasControl(name);
  if (authType === "query") return AUTH_QUERY_NAME.test(name);
  return true;
}

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
    query: z.array(z.string().trim().regex(/^[A-Za-z0-9_.-]{1,64}$/)).max(50).default([]),
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
  authType: z.enum(MCP_STATIC_AUTH_TYPES).default("none"),
  authHeader: z.string().trim().max(64).default(""),
  notes: z.string().trim().max(2000).default(""),
});

export const builderModelSchema = z.string().trim().max(200);

export const MCP_DOCS_AUTH_TYPES = ["none", "bearer", "basic", "header", "query", "cookie"] as const;
export const MAX_BUILDER_LINKS = 10;
export const MAX_CRAWL_DEPTH = 8;
export const MAX_BUILDER_FILES = 10;
export const MAX_BUILDER_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_BUILDER_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_BUILDER_REQUEST_BYTES = MAX_BUILDER_UPLOAD_BYTES + 4 * 1024 * 1024;
export const MCP_BUILDER_FILE_EXTENSIONS = [
  "pdf", "docx", "pptx", "xlsx", "png", "jpg", "jpeg", "webp", "gif",
  "txt", "md", "markdown", "mdx", "rst", "adoc", "json", "jsonl", "yaml", "yml", "toml", "xml", "csv", "tsv",
  "html", "htm", "xhtml", "graphql", "proto", "raml", "wsdl", "har", "http",
] as const;

const DOCS_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const DOCS_QUERY_NAME = /^[A-Za-z0-9_.~[\]-]{1,64}$/;
const DOCS_HEADER_VALUE = /^[\x20-\x7e]*$/;
const RESERVED_DOCS_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "expect",
  "host",
  "http2-settings",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function hasUserInfo(value: string): boolean {
  const url = new URL(value);
  return Boolean(url.username || url.password);
}

export const builderLinkSchema = z
  .object({
    url: z.string().trim().max(2048),
    internal: z.boolean().default(false),
    crawl: z.boolean().default(true),
    auth: z.enum(MCP_DOCS_AUTH_TYPES).default("none"),
    name: z.string().trim().max(256).default(""),
    secret: z.string().max(4096).default(""),
  })
  .superRefine((link, ctx) => {
    const flag = (path: "url" | "name" | "secret", message: "required" | "invalid" | "insecure") =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (!link.url) flag("url", "required");
    else if (!/^https?:\/\/\S+$/i.test(link.url) || !URL.canParse(link.url) || hasUserInfo(link.url)) flag("url", "invalid");
    else if (/^http:/i.test(link.url) && !link.internal) flag("url", "insecure");
    if (link.auth === "none") return;
    if (link.auth === "basic") {
      if (!link.name) flag("name", "required");
      else if (link.name.includes(":") || hasControl(link.name)) flag("name", "invalid");
      if (hasControl(link.secret)) flag("secret", "invalid");
      return;
    }
    if (link.auth === "header") {
      if (!link.name) flag("name", "required");
      else if (!DOCS_HEADER_NAME.test(link.name) || RESERVED_DOCS_HEADERS.has(link.name.toLowerCase())) flag("name", "invalid");
    }
    if (link.auth === "query") {
      if (!link.name) flag("name", "required");
      else if (!DOCS_QUERY_NAME.test(link.name)) flag("name", "invalid");
    }
    if (!link.secret) flag("secret", "required");
    else if (link.auth === "query" ? hasControl(link.secret) : !DOCS_HEADER_VALUE.test(link.secret)) flag("secret", "invalid");
  });

export const builderDraftSchema = z.object({
  template: z.enum(MCP_BUILDER_TEMPLATES).default("custom"),
  instruction: z.string().trim().min(1).max(2_000),
  docs: z.string().trim().max(MAX_BUILDER_DOCS).default(""),
  links: z.array(builderLinkSchema).max(MAX_BUILDER_LINKS).default([]),
});

export const hostedServerSchema = z
  .object({
    name: z.string().trim().min(1).max(48),
    description: z.string().trim().max(500),
    baseUrl: z.string().trim().min(1).max(2048),
    internal: z.boolean(),
    authType: z.enum(MCP_STATIC_AUTH_TYPES),
    authHeader: z.string().trim().max(64).default(""),
    secret: z
      .string()
      .max(4096)
      .default("")
      .refine((value) => ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127), {
        message: "invalid characters",
      }),
    tools: z.array(hostedToolSchema).min(1).max(MAX_HOSTED_TOOLS),
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
    if (!authNameValid(value.authType, value.authHeader)) {
      ctx.addIssue({ code: "custom", path: ["authHeader"], message: "invalid name" });
    }
    if (value.authType !== "none" && !value.template && !value.secret.trim()) {
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
    if (!AUTH_HEADER_NAME.test(value.authHeader) || RESERVED_HEADERS.has(value.authHeader.toLowerCase())) {
      ctx.addIssue({ code: "custom", path: ["authHeader"], message: "invalid header name" });
    }
  } else if (!authNameValid(value.authType, value.authHeader)) {
    ctx.addIssue({ code: "custom", path: ["authHeader"], message: "invalid name" });
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
    authType: z.enum(MCP_STATIC_AUTH_TYPES),
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
    if (!authNameValid(value.authType, value.authHeader)) {
      ctx.addIssue({ code: "custom", path: ["authHeader"], message: "invalid name" });
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

export const MCP_KEY_ACCESS_MODES = ["inherit", "allow", "block"] as const;

export const keyMcpAccessSchema = z.object({
  keyId: z.string().min(1).max(64),
  servers: z
    .array(
      z.object({
        serverId: z.string().min(1).max(64),
        mode: z.enum(MCP_KEY_ACCESS_MODES),
        roleId: z.string().max(64).default(""),
        blockedTools: toolNames.default([]),
        blockedActions: actions.default([]),
      }),
    )
    .max(500),
});
