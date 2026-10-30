import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import type {
  AddProviderFilter,
  AddProviderOption,
  AddProviderSection,
  ImportOption,
  ProviderKindSpec,
  ProvidersTab,
  SignInKind,
} from "@/types/providers";

export const ADD_PROVIDER_FILTERS = ["all", "api", "subscription", "import"] as const satisfies readonly AddProviderFilter[];

export const ADD_PROVIDER_SECTIONS = ["api", "subscription", "import"] as const satisfies readonly AddProviderSection[];

export const IMPORT_OPTIONS = ["files", "server", "link"] as const satisfies readonly ImportOption[];

export type KindText = "kindName" | "kindShort" | "kindDescription";

const API_KIND_ORDER = [
  "openai",
  "anthropic",
  "openrouter",
  "openrouter_eu",
  "gemini",
  "vertex",
  "xai",
  "moonshot",
  "moonshot_cn",
  "meta",
  "typesafe",
  "openai_compat",
];

const SIGN_IN_KIND_ORDER = [
  "claude",
  "codex",
  "antigravity",
  "grok_build",
  "kimi",
  "kimi_ai",
  "muse_code",
  "devin",
] as const satisfies readonly SignInKind[];

function byOrder(order: readonly string[]) {
  const rank = (kind: string) => {
    const index = order.indexOf(kind);
    return index === -1 ? order.length : index;
  };
  return (a: ProviderKindSpec, b: ProviderKindSpec) => rank(a.kind) - rank(b.kind);
}

export const API_CATALOG = PROVIDER_CATALOG.filter((spec) => !isSignInKind(spec.kind)).sort(byOrder(API_KIND_ORDER));

export const SUBSCRIPTION_CATALOG = PROVIDER_CATALOG.filter(
  (spec): spec is ProviderKindSpec & { kind: SignInKind } => isSignInKind(spec.kind),
).sort(byOrder(SIGN_IN_KIND_ORDER));

export function providerOptions(section: AddProviderSection): AddProviderOption[] {
  if (section === "api") return API_CATALOG.map((spec) => ({ id: spec.kind, section, spec }));
  if (section === "subscription") return SUBSCRIPTION_CATALOG.map((spec) => ({ id: spec.kind, section, spec }));
  return IMPORT_OPTIONS.map((option) => ({ id: `import:${option}`, section, option }));
}

export function sectionsFor(filter: AddProviderFilter): AddProviderSection[] {
  return filter === "all" ? [...ADD_PROVIDER_SECTIONS] : [filter];
}

export function optionById(id: string | null): AddProviderOption | null {
  if (!id) return null;
  return ADD_PROVIDER_SECTIONS.flatMap(providerOptions).find((option) => option.id === id) ?? null;
}

export function filterOf(kind: string): AddProviderSection {
  return isSignInKind(kind) ? "subscription" : "api";
}

export function poolTab(kind: string): ProvidersTab {
  return isSignInKind(kind) ? "subscriptions" : "api";
}

export function kindSearchText(kind: string, text: (key: KindText, kind: string) => string): string {
  return [text("kindName", kind), text("kindShort", kind), text("kindDescription", kind)].join(" ");
}
