import type { SignInKind, SignInMethod, ProviderKindSpec } from "@/types/providers";

export const PROVIDER_CATALOG: ProviderKindSpec[] = [
  { kind: "openai", name: "OpenAI", default_base_url: "https://api.openai.com/v1" },
  { kind: "anthropic", name: "Anthropic", default_base_url: "https://api.anthropic.com" },
  { kind: "openrouter", name: "OpenRouter", default_base_url: "https://openrouter.ai/api/v1" },
  { kind: "openrouter_eu", name: "OpenRouter EU", default_base_url: "https://eu.openrouter.ai/api/v1" },
  { kind: "xai", name: "xAI Grok", default_base_url: "https://api.x.ai/v1" },
  { kind: "typesafe", name: "TypeSafe AI", default_base_url: "https://api.typesafe.ai" },
  { kind: "openai_compat", name: "OpenAI-compatible" },
  { kind: "gemini", name: "Google Gemini API", default_base_url: "https://generativelanguage.googleapis.com/v1beta" },
  { kind: "vertex", name: "Google Vertex AI", default_base_url: "https://aiplatform.googleapis.com/v1" },
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
  {
    kind: "claude",
    name: "Claude subscription (Claude Code)",
    default_base_url: "https://api.anthropic.com",
    auth: "sign_in",
  },
  {
    kind: "antigravity",
    name: "Google subscription (Antigravity)",
    default_base_url: "https://daily-cloudcode-pa.googleapis.com",
    auth: "sign_in",
  },
  { kind: "moonshot", name: "Kimi API Platform", default_base_url: "https://api.moonshot.ai/v1" },
  { kind: "moonshot_cn", name: "Kimi API Platform China", default_base_url: "https://api.moonshot.cn/v1" },
  {
    kind: "kimi",
    name: "Kimi subscription (Kimi Code)",
    default_base_url: "https://api.kimi.com/coding/v1",
    auth: "sign_in",
  },
  {
    kind: "kimi_ai",
    name: "Kimi.ai subscription (Kimi Code)",
    default_base_url: "https://api.kimi.ai/coding/v1",
    auth: "sign_in",
  },
  { kind: "meta", name: "Meta Model API", default_base_url: "https://api.meta.ai/v1" },
  {
    kind: "muse_code",
    name: "Meta subscription (Muse Code)",
    default_base_url: "https://api.meta.ai/v1",
    auth: "sign_in",
  },
  {
    kind: "devin",
    name: "Devin subscription",
    default_base_url: "https://server.codeium.com",
    auth: "sign_in",
  },
];

const LIMIT_KINDS = new Set(["codex", "claude", "grok_build", "antigravity", "kimi", "kimi_ai", "muse_code", "devin"]);
const TRAFFIC_LIMIT_KINDS = new Set(["muse_code"]);
const KIMI_CODE_KINDS = new Set(["kimi", "kimi_ai"]);
const KIMI_KINDS = new Set(["kimi", "kimi_ai", "moonshot", "moonshot_cn"]);
const MUSE_KINDS = new Set(["meta", "muse_code"]);
const CODE_SIGN_IN_KINDS = new Set<SignInKind>(["claude", "antigravity", "devin"]);

export function isSignInKind(kind: string): kind is SignInKind {
  return PROVIDER_CATALOG.some((spec) => spec.kind === kind && spec.auth === "sign_in");
}

export function signInKinds(): SignInKind[] {
  return PROVIDER_CATALOG.flatMap((spec) => (isSignInKind(spec.kind) ? [spec.kind] : []));
}

export function reportsLimits(kind: string): boolean {
  return LIMIT_KINDS.has(kind);
}

export function limitsFromTraffic(kind: string): boolean {
  return TRAFFIC_LIMIT_KINDS.has(kind);
}

export function signInMethod(kind: SignInKind): SignInMethod {
  return CODE_SIGN_IN_KINDS.has(kind) ? "code" : "device";
}

export function speaksAnthropic(kind: string): boolean {
  return kind === "anthropic" || kind === "claude";
}

export function speaksGoogle(kind: string): boolean {
  return kind === "gemini" || kind === "vertex";
}

export function isKimiCodeKind(kind: string): boolean {
  return KIMI_CODE_KINDS.has(kind);
}

export function speaksKimi(kind: string): boolean {
  return KIMI_KINDS.has(kind);
}

export function speaksMuse(kind: string): boolean {
  return MUSE_KINDS.has(kind);
}

export function servesMessages(kind: string): boolean {
  return speaksAnthropic(kind) || isKimiCodeKind(kind);
}
