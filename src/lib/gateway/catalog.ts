import type { KindSpec } from "@/types/gateway";
import type { SignInKind } from "@/types/providers";

export const PROVIDER_CATALOG: KindSpec[] = [
  { kind: "openai", name: "OpenAI", default_base_url: "https://api.openai.com/v1" },
  { kind: "anthropic", name: "Anthropic", default_base_url: "https://api.anthropic.com" },
  { kind: "openrouter", name: "OpenRouter", default_base_url: "https://openrouter.ai/api/v1" },
  { kind: "openrouter_eu", name: "OpenRouter EU", default_base_url: "https://eu.openrouter.ai/api/v1" },
  { kind: "xai", name: "xAI Grok", default_base_url: "https://api.x.ai/v1" },
  { kind: "typesafe", name: "TypeSafe AI", default_base_url: "https://api.typesafe.ai" },
  { kind: "openai_compat", name: "OpenAI-compatible" },
  {
    kind: "codex",
    name: "ChatGPT subscription (Codex)",
    default_base_url: "https://chatgpt.com/backend-api/codex",
    auth: "sign_in",
  },
  {
    kind: "grok_build",
    name: "SuperGrok subscription (Grok Build)",
    default_base_url: "https://api.x.ai/v1",
    auth: "sign_in",
  },
];

const LIMIT_KINDS = new Set(["codex"]);

export function isSignInKind(kind: string): kind is SignInKind {
  return PROVIDER_CATALOG.some((spec) => spec.kind === kind && spec.auth === "sign_in");
}

export function reportsLimits(kind: string): boolean {
  return LIMIT_KINDS.has(kind);
}
