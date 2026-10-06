import "server-only";

import prisma from "@/lib/db/prisma";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import { isActionFail } from "@/lib/http/action-result";
import { createKeyAction } from "@/app/(app)/_action";
import { createProviderAction } from "@/app/(app)/providers/_action";
import { createModelGroupAction } from "@/app/(app)/models/_action";
import type { SetupNext, PublicKeyView, McpToolDef, AssistantContext } from "@/types/assistant";
import { usageTotals } from "@/lib/gateway/usage-totals";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";

export const ASSISTANT_PAGES: Record<string, string> = {
  keys: "/keys",
  playground: "/playground",
  providers: "/providers",
  models: "/models",
  "model-templates": "/model-templates",
  guardrails: "/guardrails",
  usage: "/usage",
  logs: "/logs",
  companies: "/companies",
  structure: "/companies",
  organizations: "/companies",
  departments: "/companies",
  teams: "/companies",
  projects: "/companies",
  people: "/companies",
  members: "/companies",
  users: "/users",
  budgets: "/companies",
  "api-ref": "/api-ref",
  cache: "/cache",
  router: "/models",
  logging: "/logging",
  roles: "/roles",
  "admin-settings": "/admin-settings",
};

export const ASSISTANT_EXPLAIN: Record<string, string> = {
  setup:
    "Connect one provider with an API key, add a public model alias that points at that provider, then create a virtual key. Clients call /v1 with Authorization: Bearer and that key. Playground tests the same path as a signed-in operator.",
  tenancy:
    "Customers live on the Companies page. A company is the tenant. Inside it, departments carry shared budgets and RPM and TPM limits (for example IT at most 5000 per month). Projects belong to a company and optionally to a department; people are the company's own users, not console users, and also optionally sit in a department. Every customer API key belongs to exactly one project (a project key) or one person (a personal key), so spend rolls up to the department and the company. Console users are separate: platform users see every company, and a console user assigned to a company only sees and manages that company.",
  keys:
    "API keys are hashed Bearer credentials for /v1. The full secret is shown once in the console. A key belongs to a project or a person of a company, or is an internal key of the console user who created it. Keys can be limited to models or model templates, client IPs, RPM, and TPM, and can be blocked or rotated.",
  templates:
    "Model templates are reusable model allowlists for API keys. A template combines rules (provider connections, name patterns such as claude-*, zero data retention, maximum provider data retention, data region, no training on prompts) with always-included models. Rules are evaluated on every request, so new matching models are allowed automatically. A model qualifies only when every endpoint behind it, including fallback and overflow aliases, meets every rule. Data policy is set per provider connection on the Providers page.",
  providers:
    "A provider connection stores the upstream kind, base URL, and sealed API key. OpenAI, Anthropic, OpenRouter, xAI, and any OpenAI-compatible server are supported.",
  models:
    "A model alias is the public name clients send as model. It load-balances across deployments on connected providers.",
  v1: "OpenAI-compatible API is at /v1 on this origin. Point the OpenAI SDK baseURL at origin/v1 and use a virtual key.",
  playground:
    "Playground streams chat through the gateway as the signed-in operator. It does not need a virtual key. A model alias must exist.",
  budgets:
    "Budgets cap spend on a company, department, project, person, console user, or key and are managed on the Companies page (key budgets also on API keys). Every request is checked against the whole chain: key, its person or project, department, and company; internal keys and the playground check the console user and their company. A child budget cannot exceed its parent. When any cap is reached, further /v1 calls are blocked until the period resets, the cap is raised, or a temporary boost is added.",
  guardrails:
    "Guardrails are a gateway-wide PII policy that masks or blocks matches in prompts before they reach the upstream model and can redact model output. A company or a single API key can override it with its own mode, output setting, and entity list; a key override wins over its company.",
  cache:
    "The response cache answers identical non-streaming chat requests from the same key from memory for the configured TTL. Configure it under Cache.",
  router:
    "Each model alias has a routing strategy, retries, fallback aliases, and an overflow alias used when no deployment is healthy. Deployments are the upstream endpoints behind that alias.",
  logging:
    "Request logs record metadata, usage powers the charts, and alert webhooks fire for the events each one subscribes to: upstream exhaustion, budget thresholds, and provider model changes. Retention and S3 archiving are configured under Logging & alerts.",
  usage:
    "Usage is spend and request volume. Export CSV or JSONL from the usage and logs screens. Viewers only see their own keys.",
  roles:
    "Roles are editable permission bundles. Built-in templates are admin, operator, finance, and viewer; custom roles combine permissions per area. Nobody can grant permissions they do not hold, and the owner always has full access. Every sign-in needs a second factor: an authenticator app, a recovery code, or a passkey.",
  sso:
    "OIDC single sign-on is configured in Settings (client secret in OIDC_CLIENT_SECRET). SCIM provisioning is /scim/v2/Users with the SCIM token from Settings. The owner always signs in locally.",
};

const WRITE_TOOL_PERMS = {
  create_provider: PERMISSIONS.PROVIDERS_MANAGE,
  create_model: PERMISSIONS.MODELS_MANAGE,
  create_key: PERMISSIONS.KEYS_MANAGE,
} as const;

export function isWriteTool(name: string): name is keyof typeof WRITE_TOOL_PERMS {
  return Object.hasOwn(WRITE_TOOL_PERMS, name);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function nextSetupStep(counts: {
  providers: number;
  models: number;
  keys: number;
}): SetupNext {
  if (counts.providers === 0) return "connect_provider";
  if (counts.models === 0) return "add_model";
  if (counts.keys === 0) return "create_key";
  return "ready";
}

export function toPublicKeyView(row: {
  keyAlias: string;
  prefix: string;
  spend: Prisma.Decimal | number;
  maxBudget: Prisma.Decimal | number;
  blocked: boolean;
}): PublicKeyView {
  return {
    alias: row.keyAlias,
    prefix: row.prefix,
    spend: money(row.spend),
    maxBudget: money(row.maxBudget),
    blocked: row.blocked,
  };
}

function seesAllKeys(ctx: AssistantContext): boolean {
  return hasPerm(ctx.permissions, PERMISSIONS.KEYS_READ_ALL);
}

function pageHref(page: string): string | null {
  return ASSISTANT_PAGES[page] ?? null;
}

function explainTopic(topic: string): string | null {
  return ASSISTANT_EXPLAIN[topic] ?? null;
}

function canUseMcpTool(name: string, ctx: AssistantContext): boolean {
  if (!isWriteTool(name)) return true;
  return ctx.allowWrite && hasPerm(ctx.permissions, WRITE_TOOL_PERMS[name]);
}

function visibleMcpTools(ctx?: AssistantContext): McpToolDef[] {
  const tools = listMcpTools();
  if (!ctx) return tools;
  return tools.filter((tool) => canUseMcpTool(tool.name, ctx));
}

export function listMcpTools(): McpToolDef[] {
  return [
    {
      name: "get_setup_status",
      description: "Counts providers, models, and keys and names the next setup step.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_overview",
      description: "Seven-day spend, request, and error counts plus setup totals.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_provider_kinds",
      description: "Catalog of provider kinds this gateway can connect.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_providers",
      description: "Connected providers. No API keys.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_models",
      description: "Public model aliases and how many deployments each has.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_keys",
      description: "Virtual key aliases and prefixes only. Never full secrets.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "explain",
      description: "Explain a dashboard concept.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["topic"],
        properties: {
          topic: {
            type: "string",
            enum: Object.keys(ASSISTANT_EXPLAIN),
          },
        },
      },
    },
    {
      name: "open_page",
      description: "Show the operator a link to a console page.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["page"],
        properties: {
          page: { type: "string", enum: Object.keys(ASSISTANT_PAGES) },
        },
      },
    },
    {
      name: "create_provider",
      description:
        "Create a provider connection without a key and open the Providers page, where the operator enters the API key. Never ask for API keys in chat. Requires providers:manage.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { type: "string" },
          name: { type: "string" },
          baseUrl: { type: "string" },
        },
      },
    },
    {
      name: "create_model",
      description: "Add a public model alias on a connected provider. Requires models:manage.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["alias", "providerId", "upstreamModel"],
        properties: {
          alias: { type: "string" },
          providerId: { type: "string" },
          upstreamModel: { type: "string" },
        },
      },
    },
    {
      name: "create_key",
      description:
        "Create a virtual key. Pass projectId for a project key or memberId for a person's key; with neither it is an internal key of the operator. Returns the full secret once. Requires keys:manage.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["alias"],
        properties: {
          alias: { type: "string" },
          projectId: { type: "string" },
          memberId: { type: "string" },
        },
      },
    },
  ];
}

export function mcpToolsForModel(ctx?: AssistantContext) {
  return visibleMcpTools(ctx).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AssistantContext,
): Promise<{ result: unknown; navigate?: string; secret?: string }> {
  if (isWriteTool(name) && !ctx.allowWrite) {
    return { result: { error: "read_only" } };
  }
  switch (name) {
    case "get_setup_status": {
      const keyWhere = seesAllKeys(ctx) ? {} : { userId: ctx.userId };
      const [providers, models, keys] = await Promise.all([
        prisma.providerConnection.count(),
        prisma.modelGroup.count(),
        prisma.virtualKey.count({ where: keyWhere }),
      ]);
      return {
        result: {
          providers,
          models,
          keys,
          next: nextSetupStep({ providers, models, keys }),
        },
      };
    }
    case "get_overview": {
      if (!hasPerm(ctx.permissions, PERMISSIONS.SPEND_READ)) {
        return { result: { error: "forbidden" } };
      }
      const keyWhere = seesAllKeys(ctx) ? {} : { userId: ctx.userId };
      const [providers, models, keys, totals] = await Promise.all([
        prisma.providerConnection.count(),
        prisma.modelGroup.count(),
        prisma.virtualKey.count({ where: keyWhere }),
        usageTotals(
          7,
          hasPerm(ctx.permissions, PERMISSIONS.SPEND_READ_ALL) ? {} : { userId: ctx.userId },
        ),
      ]);
      return {
        result: {
          providers,
          models,
          keys,
          ...totals,
        },
      };
    }
    case "list_provider_kinds":
      return {
        result: PROVIDER_CATALOG.map((row) => ({
          kind: row.kind,
          name: row.name,
          defaultBaseUrl: row.default_base_url ?? "",
        })),
      };
    case "list_providers": {
      if (!hasPerm(ctx.permissions, PERMISSIONS.PROVIDERS_READ)) {
        return { result: { error: "forbidden" } };
      }
      const rows = await prisma.providerConnection.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, kind: true, baseUrl: true, apiKey: true },
      });
      return { result: rows.map(({ apiKey, ...row }) => ({ ...row, hasApiKey: Boolean(apiKey) })) };
    }
    case "list_models": {
      if (!hasPerm(ctx.permissions, PERMISSIONS.MODELS_READ)) {
        return { result: { error: "forbidden" } };
      }
      const rows = await prisma.modelGroup.findMany({
        orderBy: { alias: "asc" },
        include: { deployments: { select: { id: true } } },
      });
      return {
        result: rows.map((row) => ({
          alias: row.alias,
          strategy: row.strategy,
          endpoints: row.deployments.length,
        })),
      };
    }
    case "list_keys": {
      if (!hasPerm(ctx.permissions, PERMISSIONS.KEYS_READ)) {
        return { result: { error: "forbidden" } };
      }
      const rows = await prisma.virtualKey.findMany({
        where: seesAllKeys(ctx) ? {} : { userId: ctx.userId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          keyAlias: true,
          prefix: true,
          spend: true,
          maxBudget: true,
          blocked: true,
        },
      });
      return { result: rows.map(toPublicKeyView) };
    }
    case "explain": {
      const topic = str(args.topic);
      const text = explainTopic(topic);
      if (!text) return { result: { error: "unknown_topic" } };
      return { result: { topic, text } };
    }
    case "open_page": {
      const href = pageHref(str(args.page));
      if (!href) return { result: { error: "unknown_page" } };
      return { result: { href }, navigate: href };
    }
    case "create_provider": {
      if (!hasPerm(ctx.permissions, PERMISSIONS.PROVIDERS_MANAGE)) {
        return { result: { error: "forbidden" } };
      }
      const created = await createProviderAction({
        name: str(args.name),
        kind: str(args.kind),
        baseUrl: str(args.baseUrl),
        apiKey: "",
      });
      if (isActionFail(created)) return { result: { error: created.message } };
      const provider = created.provider;
      return {
        result: {
          ok: true,
          id: provider?.id,
          name: provider?.name,
          kind: provider?.kind,
          next: "The operator adds the API key on the Providers page.",
        },
        navigate: "/providers",
      };
    }
    case "create_model": {
      if (!hasPerm(ctx.permissions, PERMISSIONS.MODELS_MANAGE)) {
        return { result: { error: "forbidden" } };
      }
      const providerId = str(args.providerId);
      const provider = await prisma.providerConnection.findUnique({
        where: { id: providerId },
      });
      if (!provider) return { result: { error: "provider_not_found" } };
      const created = await createModelGroupAction({
        alias: str(args.alias),
        strategy: "least_inflight",
        numRetries: 2,
        overflowGroup: "",
        fallbackGroups: [],
        deployments: [
          {
            kind: provider.kind,
            baseUrl: provider.baseUrl,
            model: str(args.upstreamModel),
            weight: 1,
            costInput: 0,
            costOutput: 0,
            providerId: provider.id,
          },
        ],
      });
      if (isActionFail(created)) return { result: { error: created.message } };
      return {
        result: { ok: true, alias: str(args.alias) },
        navigate: "/models",
      };
    }
    case "create_key": {
      if (!hasPerm(ctx.permissions, PERMISSIONS.KEYS_MANAGE)) {
        return { result: { error: "forbidden" } };
      }
      const created = await createKeyAction({
        alias: str(args.alias) || "assistant-key",
        projectId: str(args.projectId),
        memberId: str(args.memberId),
      });
      if (isActionFail(created)) return { result: { error: created.message } };
      return {
        result: {
          ok: true,
          alias: created.key.key_alias,
          prefix: created.key.key_name,
          note: "The console already showed the operator the secret once. Never ask for it or repeat it.",
        },
        secret: created.key.key,
        navigate: "/keys",
      };
    }
    default:
      return { result: { error: "unknown_tool" } };
  }
}
