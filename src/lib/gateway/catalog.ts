import type { KindSpec } from "@/types/gateway";

export const PROVIDER_CATALOG: KindSpec[] = [
  { kind: "openai", name: "OpenAI", default_base_url: "https://api.openai.com/v1" },
  { kind: "anthropic", name: "Anthropic", default_base_url: "https://api.anthropic.com" },
  { kind: "openrouter", name: "OpenRouter", default_base_url: "https://openrouter.ai/api/v1" },
  { kind: "openrouter_eu", name: "OpenRouter EU", default_base_url: "https://eu.openrouter.ai/api/v1" },
  { kind: "xai", name: "xAI Grok", default_base_url: "https://api.x.ai/v1" },
  { kind: "typesafe", name: "TypeSafe AI", default_base_url: "https://api.typesafe.ai" },
  { kind: "openai_compat", name: "OpenAI-compatible" },
];
