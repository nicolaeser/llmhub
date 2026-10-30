import { ANTHROPIC_VERSION } from "@/lib/gateway/endpoints/openapi";
import { API_PREFIX, SUBSCRIPTION_PREFIX } from "@/lib/gateway/api-paths";
import type { ConnectRoute } from "@/types/api-ref";

export const KEY_PLACEHOLDER = "sk-hub-…";
export const MODEL_PLACEHOLDER = "model-name";
export const DESKTOP_CONFIG_FILE = "llmhub-claude-desktop.json";

export type ConnectGroup = "coding" | "apps" | "code" | "other";
export type ConnectProtocol = "openai" | "anthropic" | "choice";
export type ConnectShell = "posix" | "windows";
export type ConnectSdk = "openai" | "anthropic";

export const CONNECT_TOOLS = [
  { id: "claudeCode", group: "coding", protocol: "anthropic", route: "subscription", needsModel: false, shell: true },
  { id: "codex", group: "coding", protocol: "openai", route: "subscription", needsModel: false, shell: true },
  { id: "opencode", group: "coding", protocol: "openai", route: "subscription", needsModel: true, shell: false },
  { id: "cursor", group: "coding", protocol: "openai", route: "api", needsModel: true, shell: false },
  { id: "cline", group: "coding", protocol: "openai", route: "api", needsModel: true, shell: false },
  { id: "continue", group: "coding", protocol: "openai", route: "api", needsModel: true, shell: false },
  { id: "aider", group: "coding", protocol: "openai", route: "api", needsModel: true, shell: true },
  { id: "zed", group: "coding", protocol: "openai", route: "api", needsModel: true, shell: false },
  { id: "claudeDesktop", group: "apps", protocol: "anthropic", route: "subscription", needsModel: false, shell: false },
  { id: "openWebui", group: "apps", protocol: "openai", route: "api", needsModel: false, shell: false },
  { id: "python", group: "code", protocol: "choice", route: "api", needsModel: true, shell: false },
  { id: "node", group: "code", protocol: "choice", route: "api", needsModel: true, shell: false },
  { id: "curl", group: "code", protocol: "choice", route: "api", needsModel: true, shell: true },
  { id: "other", group: "other", protocol: "openai", route: "api", needsModel: true, shell: true },
] as const satisfies readonly {
  id: string;
  group: ConnectGroup;
  protocol: ConnectProtocol;
  route: ConnectRoute;
  needsModel: boolean;
  shell: boolean;
}[];

export type ConnectTool = (typeof CONNECT_TOOLS)[number]["id"];
export type ConnectToolMeta = (typeof CONNECT_TOOLS)[number];

export const CONNECT_GROUPS: readonly ConnectGroup[] = ["coding", "apps", "code", "other"];

export type GuideValues = {
  origin: string;
  route: ConnectRoute;
  key: string;
  model: string;
  shell: ConnectShell;
  sdk: ConnectSdk;
};

export type GuideCode = { text: string; file?: string; download?: string };

export type GuideField = { id: "name" | "url" | "key" | "model"; value: string };

export type GuideStep = {
  id: string;
  args?: Record<string, string>;
  code?: GuideCode;
  fields?: GuideField[];
  alt?: { id: string; code: GuideCode };
};

export type ToolGuide = { steps: GuideStep[]; notes: string[] };

export function connectTool(id: string | null | undefined): ConnectToolMeta {
  return CONNECT_TOOLS.find((tool) => tool.id === id) ?? CONNECT_TOOLS[0];
}

export function toolProtocol(tool: ConnectToolMeta, sdk: ConnectSdk): Exclude<ConnectProtocol, "choice"> {
  return tool.protocol === "choice" ? sdk : tool.protocol;
}

export function gatewayUrls(origin: string, route: ConnectRoute) {
  const root = `${origin}${route === "subscription" ? SUBSCRIPTION_PREFIX : API_PREFIX}`;
  return { openai: `${root}/v1`, anthropic: root, models: `${root}/v1/models` };
}

export function routeModels(models: Record<ConnectRoute, string[]>, route: ConnectRoute): string[] {
  return route === "subscription" ? [...models.subscription, ...models.api.map((alias) => `api/${alias}`)] : models.api;
}

export function chatFirst(ids: readonly string[], models: Record<ConnectRoute, string[]>): string[] {
  const chat = new Set([...models.api, ...models.subscription]);
  const isChat = (id: string) => chat.has(id.replace(/^api\//, ""));
  return [...ids.filter(isChat), ...ids.filter((id) => !isChat(id))];
}

export function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function envLines(vars: readonly (readonly [string, string])[], shell: ConnectShell): string {
  return vars
    .map(([name, value]) => (shell === "windows" ? `$env:${name} = "${value}"` : `export ${name}="${value}"`))
    .join("\n");
}

export function claudeDesktopConfig(gatewayBaseUrl: string, key: string): string {
  return json({
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: gatewayBaseUrl,
    inferenceGatewayApiKey: key,
    inferenceGatewayAuthScheme: "bearer",
  });
}

function claudeCodeGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  const env = [
    ["ANTHROPIC_BASE_URL", urls.anthropic],
    ["ANTHROPIC_AUTH_TOKEN", values.key],
    ["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1"],
  ] as const;
  return {
    steps: [
      {
        id: "settings",
        code: { file: "~/.claude/settings.json", text: json({ env: Object.fromEntries(env) }) },
        alt: { id: "terminal", code: { text: `${envLines(env, values.shell)}\nclaude` } },
      },
      { id: "start" },
      { id: "status" },
      { id: "check" },
    ],
    notes: ["models", "vscode", "gatewayMode"],
  };
}

function claudeDesktopGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  return {
    steps: [
      {
        id: "download",
        code: { text: claudeDesktopConfig(urls.anthropic, values.key), download: DESKTOP_CONFIG_FILE },
      },
      { id: "developer" },
      { id: "import", args: { file: DESKTOP_CONFIG_FILE } },
      { id: "apply", args: { key: KEY_PLACEHOLDER } },
      { id: "check" },
    ],
    notes: ["claudeOnly", "https", "fleet"],
  };
}

function codexGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  const config = [
    'model_provider = "llmhub"',
    "",
    "[model_providers.llmhub]",
    'name = "LLM Hub"',
    `base_url = "${urls.openai}"`,
    `model_catalog_url = "${urls.models}"`,
    'env_key = "LLMHUB_API_KEY"',
    'wire_api = "responses"',
  ].join("\n");
  return {
    steps: [
      { id: "config", code: { file: "~/.codex/config.toml", text: config } },
      { id: "key", code: { text: envLines([["LLMHUB_API_KEY", values.key]], values.shell) } },
      { id: "start" },
      { id: "check" },
    ],
    notes: ["persist"],
  };
}

function opencodeGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  const config = json({
    $schema: "https://opencode.ai/config.json",
    provider: {
      llmhub: {
        npm: "@ai-sdk/openai-compatible",
        name: "LLM Hub",
        options: { baseURL: urls.openai, apiKey: values.key },
        models: { [values.model]: { name: values.model } },
      },
    },
    model: `llmhub/${values.model}`,
  });
  return {
    steps: [
      { id: "config", code: { file: "~/.config/opencode/opencode.json", text: config } },
      { id: "start" },
      { id: "verify", code: { text: "opencode models llmhub" } },
      { id: "check" },
    ],
    notes: ["moreModels", "project"],
  };
}

function cursorGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  return {
    steps: [
      { id: "open" },
      { id: "key", code: { text: values.key } },
      { id: "url", code: { text: urls.openai } },
      { id: "model", code: { text: values.model } },
      { id: "check" },
    ],
    notes: ["public", "builtIn"],
  };
}

function clineGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  return {
    steps: [
      { id: "open" },
      {
        id: "fields",
        fields: [
          { id: "url", value: urls.openai },
          { id: "key", value: values.key },
          { id: "model", value: values.model },
        ],
      },
      { id: "check" },
    ],
    notes: [],
  };
}

function continueGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  const config = [
    "name: LLM Hub",
    "version: 1.0.0",
    "schema: v1",
    "models:",
    `  - name: ${JSON.stringify(values.model)}`,
    "    provider: openai",
    `    model: ${JSON.stringify(values.model)}`,
    `    apiBase: ${JSON.stringify(urls.openai)}`,
    `    apiKey: ${JSON.stringify(values.key)}`,
  ].join("\n");
  return {
    steps: [
      { id: "config", code: { file: "~/.continue/config.yaml", text: config } },
      { id: "start" },
      { id: "check" },
    ],
    notes: ["moreModels"],
  };
}

function aiderGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  return {
    steps: [
      {
        id: "env",
        code: {
          text: envLines(
            [
              ["OPENAI_API_BASE", urls.openai],
              ["OPENAI_API_KEY", values.key],
            ],
            values.shell,
          ),
        },
      },
      { id: "start", code: { text: `aider --model openai/${values.model}` } },
      { id: "check" },
    ],
    notes: ["prefix", "warning", "persist"],
  };
}

function zedGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  return {
    steps: [
      { id: "open" },
      {
        id: "fields",
        fields: [
          { id: "name", value: "llmhub" },
          { id: "url", value: urls.openai },
          { id: "key", value: values.key },
          { id: "model", value: values.model },
        ],
      },
      { id: "start" },
      { id: "check" },
    ],
    notes: ["keychain"],
  };
}

function openWebuiGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  return {
    steps: [
      { id: "open" },
      {
        id: "fields",
        fields: [
          { id: "url", value: urls.openai },
          { id: "key", value: values.key },
        ],
      },
      { id: "start" },
      { id: "check" },
    ],
    notes: ["server"],
  };
}

function pythonGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  const code =
    values.sdk === "anthropic"
      ? [
          "from anthropic import Anthropic",
          "",
          "client = Anthropic(",
          `    base_url="${urls.anthropic}",`,
          `    api_key="${values.key}",`,
          ")",
          "",
          "message = client.messages.create(",
          `    model="${values.model}",`,
          "    max_tokens=1024,",
          '    messages=[{"role": "user", "content": "Hello"}],',
          ")",
          "print(message.content[0].text)",
        ]
      : [
          "from openai import OpenAI",
          "",
          "client = OpenAI(",
          `    base_url="${urls.openai}",`,
          `    api_key="${values.key}",`,
          ")",
          "",
          "response = client.chat.completions.create(",
          `    model="${values.model}",`,
          '    messages=[{"role": "user", "content": "Hello"}],',
          ")",
          "print(response.choices[0].message.content)",
        ];
  return {
    steps: [
      { id: "install", code: { text: `pip install ${values.sdk}` } },
      { id: "code", code: { file: "hello.py", text: code.join("\n") } },
      { id: "run", code: { text: "python hello.py" } },
    ],
    notes: ["env"],
  };
}

function nodeGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  const anthropic = values.sdk === "anthropic";
  const code = anthropic
    ? [
        'import Anthropic from "@anthropic-ai/sdk";',
        "",
        "const client = new Anthropic({",
        `  baseURL: "${urls.anthropic}",`,
        `  apiKey: "${values.key}",`,
        "});",
        "",
        "const message = await client.messages.create({",
        `  model: "${values.model}",`,
        "  max_tokens: 1024,",
        '  messages: [{ role: "user", content: "Hello" }],',
        "});",
        "console.log(message.content[0].text);",
      ]
    : [
        'import OpenAI from "openai";',
        "",
        "const client = new OpenAI({",
        `  baseURL: "${urls.openai}",`,
        `  apiKey: "${values.key}",`,
        "});",
        "",
        "const response = await client.chat.completions.create({",
        `  model: "${values.model}",`,
        '  messages: [{ role: "user", content: "Hello" }],',
        "});",
        "console.log(response.choices[0].message.content);",
      ];
  return {
    steps: [
      { id: "install", code: { text: `npm install ${anthropic ? "@anthropic-ai/sdk" : "openai"}` } },
      { id: "code", code: { file: "hello.mjs", text: code.join("\n") } },
      { id: "run", code: { text: "node hello.mjs" } },
    ],
    notes: ["env"],
  };
}

function curlRequest(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): string {
  const anthropic = values.sdk === "anthropic";
  const target = anthropic ? `${urls.anthropic}/v1/messages` : `${urls.openai}/chat/completions`;
  if (values.shell === "windows") {
    const headers = anthropic
      ? `@{ Authorization = "Bearer ${values.key}"; "anthropic-version" = "${ANTHROPIC_VERSION}" }`
      : `@{ Authorization = "Bearer ${values.key}" }`;
    return [
      "$body = @{",
      `  model = "${values.model}"`,
      ...(anthropic ? ["  max_tokens = 256"] : []),
      '  messages = @(@{ role = "user"; content = "Hello" })',
      "} | ConvertTo-Json -Depth 5",
      `Invoke-RestMethod -Uri "${target}" -Method Post \``,
      `  -Headers ${headers} \``,
      '  -ContentType "application/json" -Body $body',
    ].join("\n");
  }
  const body = JSON.stringify({
    model: values.model,
    ...(anthropic ? { max_tokens: 256 } : {}),
    messages: [{ role: "user", content: "Hello" }],
  });
  return [
    `curl ${target} \\`,
    `  -H "Authorization: Bearer ${values.key}" \\`,
    ...(anthropic ? [`  -H "anthropic-version: ${ANTHROPIC_VERSION}" \\`] : []),
    '  -H "Content-Type: application/json" \\',
    `  -d '${body}'`,
  ].join("\n");
}

function curlModels(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): string {
  return values.shell === "windows"
    ? `Invoke-RestMethod -Uri "${urls.models}" -Headers @{ Authorization = "Bearer ${values.key}" }`
    : `curl ${urls.models} \\\n  -H "Authorization: Bearer ${values.key}"`;
}

function curlGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  return {
    steps: [
      { id: "models", code: { text: curlModels(values, urls) } },
      { id: "request", code: { text: curlRequest(values, urls) } },
    ],
    notes: [],
  };
}

function otherGuide(values: GuideValues, urls: ReturnType<typeof gatewayUrls>): ToolGuide {
  return {
    steps: [
      {
        id: "fields",
        fields: [
          { id: "url", value: urls.openai },
          { id: "key", value: values.key },
          { id: "model", value: values.model },
        ],
      },
      {
        id: "env",
        code: {
          text: envLines(
            [
              ["OPENAI_BASE_URL", urls.openai],
              ["OPENAI_API_KEY", values.key],
            ],
            values.shell,
          ),
        },
      },
      { id: "anthropic", args: { url: urls.anthropic } },
      { id: "check" },
    ],
    notes: ["suffix", "persist"],
  };
}

const GUIDES: Record<ConnectTool, (values: GuideValues, urls: ReturnType<typeof gatewayUrls>) => ToolGuide> = {
  claudeCode: claudeCodeGuide,
  claudeDesktop: claudeDesktopGuide,
  codex: codexGuide,
  opencode: opencodeGuide,
  cursor: cursorGuide,
  cline: clineGuide,
  continue: continueGuide,
  aider: aiderGuide,
  zed: zedGuide,
  openWebui: openWebuiGuide,
  python: pythonGuide,
  node: nodeGuide,
  curl: curlGuide,
  other: otherGuide,
};

export function toolGuide(tool: ConnectTool, values: GuideValues): ToolGuide {
  return GUIDES[tool](values, gatewayUrls(values.origin, values.route));
}
