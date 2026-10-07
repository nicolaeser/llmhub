import "server-only";

import prisma from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { assistantToolViews } from "@/lib/assistant/catalog";
import { assistantModelLocked } from "@/lib/assistant/parse";
import { ASSISTANT_EXPLAIN, ASSISTANT_PAGES } from "@/lib/assistant/knowledge";
import { PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import { ANTHROPIC_VERSION, OPENAPI_PATHS } from "@/lib/gateway/openapi";
import { getEnterprise } from "@/lib/gateway/settings";
import {
  apiEndpointsToolInput,
  codeExampleToolInput,
  emptyToolInput,
  explainToolInput,
  openPageToolInput,
} from "@/schemas/assistant";
import { defineTool } from "@/lib/assistant/tools/define";
import type { AssistantContext, SetupNext } from "@/types/assistant";

const ENDPOINT_PATHS = {
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
  embeddings: "/v1/embeddings",
} as const;

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

export function ownKeysWhere(ctx: AssistantContext) {
  return {
    ...(ctx.orgId ? { orgId: ctx.orgId } : {}),
    ...(hasPerm(ctx.permissions, PERMISSIONS.KEYS_READ_ALL) ? {} : { userId: ctx.userId }),
  };
}

function appOrigin(): string {
  return env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
}

function requestBody(endpoint: keyof typeof ENDPOINT_PATHS, model: string) {
  if (endpoint === "responses") return { model, input: "Hello" };
  if (endpoint === "embeddings") return { model, input: "Hello" };
  if (endpoint === "messages") {
    return { model, max_tokens: 256, messages: [{ role: "user", content: "Hello" }] };
  }
  return { model, messages: [{ role: "user", content: "Hello" }] };
}

export function codeExample(input: {
  origin: string;
  model: string;
  language: "curl" | "python" | "typescript";
  endpoint: keyof typeof ENDPOINT_PATHS;
}): string {
  const { origin, model, language, endpoint } = input;
  const body = requestBody(endpoint, model);
  const anthropic = endpoint === "messages";
  if (language === "curl") {
    const auth = anthropic
      ? `-H "x-api-key: $LLMHUB_API_KEY" \\\n  -H "anthropic-version: ${ANTHROPIC_VERSION}"`
      : `-H "Authorization: Bearer $LLMHUB_API_KEY"`;
    return [
      `curl ${origin}${ENDPOINT_PATHS[endpoint]} \\`,
      `  ${auth} \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '${JSON.stringify(body)}'`,
    ].join("\n");
  }
  if (language === "python") {
    if (anthropic) {
      return [
        "import os",
        "from anthropic import Anthropic",
        "",
        `client = Anthropic(base_url="${origin}", api_key=os.environ["LLMHUB_API_KEY"])`,
        `message = client.messages.create(model="${model}", max_tokens=256, messages=[{"role": "user", "content": "Hello"}])`,
        "print(message.content[0].text)",
      ].join("\n");
    }
    const call = {
      chat: `client.chat.completions.create(model="${model}", messages=[{"role": "user", "content": "Hello"}])`,
      responses: `client.responses.create(model="${model}", input="Hello")`,
      embeddings: `client.embeddings.create(model="${model}", input="Hello")`,
    }[endpoint];
    return [
      "import os",
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${origin}/v1", api_key=os.environ["LLMHUB_API_KEY"])`,
      `result = ${call}`,
      "print(result)",
    ].join("\n");
  }
  if (anthropic) {
    return [
      'import Anthropic from "@anthropic-ai/sdk";',
      "",
      `const client = new Anthropic({ baseURL: "${origin}", apiKey: process.env.LLMHUB_API_KEY });`,
      `const message = await client.messages.create(${JSON.stringify(body)});`,
      "console.log(message.content);",
    ].join("\n");
  }
  const method = {
    chat: "chat.completions.create",
    responses: "responses.create",
    embeddings: "embeddings.create",
  }[endpoint];
  return [
    'import OpenAI from "openai";',
    "",
    `const client = new OpenAI({ baseURL: "${origin}/v1", apiKey: process.env.LLMHUB_API_KEY });`,
    `const result = await client.${method}(${JSON.stringify(body)});`,
    "console.log(result);",
  ].join("\n");
}

export async function setupStatus(ctx: AssistantContext) {
  const [providers, models, keys] = await Promise.all([
    prisma.providerConnection.count(),
    prisma.modelGroup.count(),
    prisma.virtualKey.count({ where: ownKeysWhere(ctx) }),
  ]);
  return { providers, models, keys, next: nextSetupStep({ providers, models, keys }) };
}

export const generalTools = {
  get_setup_status: defineTool({
    description: "Counts providers, models, and keys and names the next setup step.",
    input: emptyToolInput,
    run: async (_args, ctx) => ({ result: await setupStatus(ctx) }),
  }),
  whoami: defineTool({
    description:
      "The signed-in operator: role, the company they are limited to (null for platform users), permissions, assistant tools available to the role, write access, and the assistant model policy.",
    input: emptyToolInput,
    run: async (_args, ctx) => {
      const [user, enterprise] = await Promise.all([
        prisma.user.findUnique({
          where: { id: ctx.userId },
          select: {
            username: true,
            isOwner: true,
            role: { select: { name: true, templateKey: true } },
            org: { select: { id: true, alias: true } },
          },
        }),
        getEnterprise(),
      ]);
      return {
        result: {
          username: user?.username ?? "",
          owner: user?.isOwner === true,
          role: user?.role?.name ?? user?.role?.templateKey ?? null,
          company: user?.org ?? null,
          permissions: ctx.permissions,
          writeAccess: ctx.allowWrite,
          tools: assistantToolViews(ctx).map((tool) => tool.name),
          disabledTools: ctx.disabledTools,
          assistantModel: {
            default: enterprise.assistant_model ?? "",
            enforced: assistantModelLocked(enterprise),
          },
        },
      };
    },
  }),
  explain: defineTool({
    description: "Explain a console concept.",
    input: explainToolInput,
    run: async ({ topic }) => ({ result: { topic, text: ASSISTANT_EXPLAIN[topic] } }),
  }),
  open_page: defineTool({
    description: "Show the operator a link to a console page.",
    input: openPageToolInput,
    run: async ({ page }) => {
      const href = ASSISTANT_PAGES[page];
      return { result: { href }, navigate: href };
    },
  }),
  list_provider_kinds: defineTool({
    description: "Catalog of provider kinds this gateway can connect, with default base URLs.",
    input: emptyToolInput,
    run: async () => ({
      result: PROVIDER_CATALOG.map((row) => ({
        kind: row.kind,
        name: row.name,
        defaultBaseUrl: row.default_base_url ?? "",
      })),
    }),
  }),
  list_api_endpoints: defineTool({
    description:
      "Gateway HTTP endpoints with method and summary: /v1 is the OpenAI and Anthropic compatible API for virtual keys, /api is the management API for management keys.",
    input: apiEndpointsToolInput,
    run: async ({ scope }) => ({
      result: {
        origin: appOrigin(),
        endpoints: OPENAPI_PATHS.filter(
          (row) => scope === "all" || row.path.startsWith(`/${scope}/`),
        ).map((row) => ({ method: row.method, path: row.path, summary: row.summary })),
      },
    }),
  }),
  code_example: defineTool({
    description:
      "Ready-to-run client code that calls this gateway with a virtual key from the LLMHUB_API_KEY environment variable.",
    input: codeExampleToolInput,
    run: async ({ model, language, endpoint }) => ({
      result: {
        language,
        endpoint: ENDPOINT_PATHS[endpoint],
        code: codeExample({ origin: appOrigin(), model, language, endpoint }),
      },
    }),
  }),
};
