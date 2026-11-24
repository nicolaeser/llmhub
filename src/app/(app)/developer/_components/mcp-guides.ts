import { API_PREFIX } from "@/lib/gateway/api-paths";
import { envLines, json, type ConnectShell, type GuideCode } from "./connect-guides";

export const MCP_SERVER_NAME = "llmhub";
export const MCP_KEY_VARIABLE = "LLMHUB_API_KEY";
export const MCP_OPT_OUT_HEADER = "X-LLMHub-MCP";
export const MCP_TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" } as const;

export const MCP_TOOLS = [
  { id: "claudeCode", shell: false },
  { id: "codex", shell: true },
  { id: "opencode", shell: false },
  { id: "cursor", shell: false },
  { id: "vscode", shell: false },
  { id: "claudeDesktop", shell: false },
  { id: "gemini", shell: false },
  { id: "other", shell: true },
] as const satisfies readonly { id: string; shell: boolean }[];

export type McpTool = (typeof MCP_TOOLS)[number]["id"];
export type McpToolMeta = (typeof MCP_TOOLS)[number];

export type McpGuideValues = { origin: string; key: string; shell: ConnectShell };

export type McpField = { id: "url" | "header" | "value" | "sse"; value: string };

export type McpStep = { id: string; code?: GuideCode; fields?: McpField[] };

export type McpNote = { id: string; args?: Record<string, string> };

export type McpGuide = { steps: McpStep[]; notes: McpNote[] };

type McpUrls = ReturnType<typeof mcpUrls>;

export function mcpTool(id: string | null | undefined): McpToolMeta {
  return MCP_TOOLS.find((tool) => tool.id === id) ?? MCP_TOOLS[0];
}

export function mcpUrls(origin: string) {
  const endpoint = `${origin}${API_PREFIX}/v1/mcp`;
  return { endpoint, sse: `${endpoint}/sse` };
}

function bearer(key: string): string {
  return `Bearer ${key}`;
}

function remoteNeedsHttp(origin: string): boolean {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  return url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function mcpToolsListRequest(values: McpGuideValues, urls: McpUrls): string {
  const body = JSON.stringify(MCP_TOOLS_LIST);
  if (values.shell === "windows") {
    return [
      `Invoke-RestMethod -Uri "${urls.endpoint}" -Method Post \``,
      `  -Headers @{ Authorization = "${bearer(values.key)}" } \``,
      `  -ContentType "application/json" -Body '${body}'`,
    ].join("\n");
  }
  return [
    `curl ${urls.endpoint} \\`,
    `  -H "Authorization: ${bearer(values.key)}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${body}'`,
  ].join("\n");
}

function claudeCodeGuide(values: McpGuideValues, urls: McpUrls): McpGuide {
  return {
    steps: [
      {
        id: "add",
        code: {
          text: `claude mcp add --transport http --scope user ${MCP_SERVER_NAME} ${urls.endpoint} --header "Authorization: ${bearer(values.key)}"`,
        },
      },
      { id: "verify" },
      { id: "check" },
    ],
    notes: [
      { id: "twice", args: { setting: `"ANTHROPIC_CUSTOM_HEADERS": "${MCP_OPT_OUT_HEADER}: off"` } },
      { id: "remove", args: { command: `claude mcp remove ${MCP_SERVER_NAME} --scope user` } },
    ],
  };
}

function codexGuide(values: McpGuideValues, urls: McpUrls): McpGuide {
  const config = [`[mcp_servers.${MCP_SERVER_NAME}]`, `url = "${urls.endpoint}"`, `bearer_token_env_var = "${MCP_KEY_VARIABLE}"`].join("\n");
  return {
    steps: [
      { id: "config", code: { file: "~/.codex/config.toml", text: config } },
      { id: "key", code: { text: envLines([[MCP_KEY_VARIABLE, values.key]], values.shell) } },
      { id: "verify" },
      { id: "check" },
    ],
    notes: [{ id: "twice", args: { setting: `http_headers = { "${MCP_OPT_OUT_HEADER}" = "off" }` } }, { id: "persist" }],
  };
}

function opencodeGuide(values: McpGuideValues, urls: McpUrls): McpGuide {
  const config = json({
    $schema: "https://opencode.ai/config.json",
    mcp: {
      [MCP_SERVER_NAME]: {
        type: "remote",
        url: urls.endpoint,
        enabled: true,
        headers: { Authorization: bearer(values.key) },
      },
    },
  });
  return {
    steps: [
      { id: "config", code: { file: "~/.config/opencode/opencode.json", text: config } },
      { id: "verify" },
      { id: "check" },
    ],
    notes: [{ id: "twice", args: { setting: `"headers": { "${MCP_OPT_OUT_HEADER}": "off" }` } }],
  };
}

function cursorGuide(values: McpGuideValues, urls: McpUrls): McpGuide {
  const config = json({
    mcpServers: { [MCP_SERVER_NAME]: { url: urls.endpoint, headers: { Authorization: bearer(values.key) } } },
  });
  return {
    steps: [
      { id: "config", code: { file: "~/.cursor/mcp.json", text: config } },
      { id: "verify" },
      { id: "check" },
    ],
    notes: [{ id: "project" }],
  };
}

function vscodeGuide(values: McpGuideValues, urls: McpUrls): McpGuide {
  const config = json({
    servers: {
      [MCP_SERVER_NAME]: { type: "http", url: urls.endpoint, headers: { Authorization: bearer(values.key) } },
    },
  });
  return {
    steps: [
      { id: "open" },
      { id: "config", code: { file: "mcp.json", text: config } },
      { id: "verify" },
      { id: "check" },
    ],
    notes: [{ id: "project" }],
  };
}

export function claudeDesktopMcpConfig(values: McpGuideValues, urls: McpUrls): string {
  return json({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          urls.endpoint,
          ...(remoteNeedsHttp(values.origin) ? ["--allow-http"] : []),
          "--header",
          "Authorization:${LLMHUB_AUTH}",
        ],
        env: { LLMHUB_AUTH: bearer(values.key) },
      },
    },
  });
}

function claudeDesktopGuide(values: McpGuideValues, urls: McpUrls): McpGuide {
  return {
    steps: [
      { id: "node" },
      { id: "open" },
      { id: "config", code: { file: "claude_desktop_config.json", text: claudeDesktopMcpConfig(values, urls) } },
      { id: "restart" },
      { id: "check" },
    ],
    notes: [{ id: "connectors" }, { id: "header" }],
  };
}

function geminiGuide(values: McpGuideValues, urls: McpUrls): McpGuide {
  const config = json({
    mcpServers: { [MCP_SERVER_NAME]: { httpUrl: urls.endpoint, headers: { Authorization: bearer(values.key) } } },
  });
  return {
    steps: [
      { id: "config", code: { file: "~/.gemini/settings.json", text: config } },
      { id: "verify" },
      { id: "check" },
    ],
    notes: [],
  };
}

function otherGuide(values: McpGuideValues, urls: McpUrls): McpGuide {
  return {
    steps: [
      {
        id: "fields",
        fields: [
          { id: "url", value: urls.endpoint },
          { id: "header", value: "Authorization" },
          { id: "value", value: bearer(values.key) },
        ],
      },
      { id: "test", code: { text: mcpToolsListRequest(values, urls) } },
      { id: "sse", fields: [{ id: "sse", value: urls.sse }] },
      { id: "check" },
    ],
    notes: [{ id: "versions" }, { id: "noHeader" }],
  };
}

const GUIDES: Record<McpTool, (values: McpGuideValues, urls: McpUrls) => McpGuide> = {
  claudeCode: claudeCodeGuide,
  codex: codexGuide,
  opencode: opencodeGuide,
  cursor: cursorGuide,
  vscode: vscodeGuide,
  claudeDesktop: claudeDesktopGuide,
  gemini: geminiGuide,
  other: otherGuide,
};

export function mcpGuide(tool: McpTool, values: McpGuideValues): McpGuide {
  return GUIDES[tool](values, mcpUrls(values.origin));
}
