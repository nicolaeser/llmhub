import "server-only";
import { getMessages } from "next-intl/server";
import type { Messages } from "@/types/i18n";
import { assignMessagePath, messageAt } from "./message-tree";

const SHARED_POOL_BADGES = ["Providers.pool", "Providers.poolHint", "Providers.signIn.plan"] as const;

export const CLIENT_NAMESPACES = {
  root: [],
  "(app)": ["Common", "Error", "Sidebar"],
  "(app)/account": ["Account", "Roles.noRole", "Roles.permissions", "Roles.templateName", "Security"],
  "(app)/companies": ["Budgets", "Companies", "Guardrails", "Keys", "Mcp", "ModelTemplates.matchCount", "Usage.labels"],
  "(app)/developer": ["ApiRef", "Developer", "Playground"],
  "(app)/guardrails": ["Guardrails", ...SHARED_POOL_BADGES],
  "(app)/keys": ["Budgets", "Keys", "Mcp", "ModelTemplates.matchCount"],
  "(app)/knowledge": ["Knowledge", ...SHARED_POOL_BADGES],
  "(app)/logs": ["Guardrails", "Logs", "Markdown"],
  "(app)/mcp": ["Mcp", ...SHARED_POOL_BADGES],
  "(app)/models": ["ModelCatalog", "ModelTemplates", "Models", "Providers"],
  "(app)/providers": ["ProviderHealth", "Providers", "Security", "Subscriptions"],
  "(app)/settings": ["Providers", "Roles", "Security", "Settings", "Usage"],
  "(app)/usage": ["Markups", "Usage"],
  "(app)/users": ["Budgets", "Roles", "Security", "Users"],
  account: [
    "Auth",
    "Common.appName",
    "Common.copied",
    "Common.copyFailed",
    "Common.goHome",
    "Common.loading",
    "Error.boundary",
    "Security",
  ],
  "providers/sub-add": [
    "Common.cancel",
    "Common.copied",
    "Common.copyFailed",
    "Common.loadFailed",
    "Common.loading",
    "Common.retry",
    "Error.boundary",
    "Error.code",
    "Providers.kindShort",
    "Providers.pool",
    "Providers.poolHint",
    "Providers.signIn",
    "SubAdd",
  ],
  "internal-api/setup": ["Common.appName", "Setup"],
} as const satisfies Record<string, readonly string[]>;

export type ClientMessageArea = keyof typeof CLIENT_NAMESPACES;

export function pickMessages(messages: Messages, paths: readonly string[]): Messages {
  const picked: Messages = {};
  for (const dottedPath of paths) {
    const value = messageAt(messages, dottedPath);
    if (value !== undefined) assignMessagePath(picked, dottedPath, value);
  }
  return picked;
}

export async function clientMessages(area: ClientMessageArea): Promise<Messages> {
  return pickMessages(await getMessages(), CLIENT_NAMESPACES[area]);
}
