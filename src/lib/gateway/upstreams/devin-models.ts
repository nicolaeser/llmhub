import { WIRE_BYTES, WIRE_VARINT, protoFields, protoNumber, protoText } from "@/lib/gateway/upstreams/devin-wire";
import type { DevinModelConfig, DevinTierMode, DevinVariant } from "@/types/devin";
import type { DiscoveredModel } from "@/types/providers";

const LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LEVEL_RANK: Readonly<Record<string, number>> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
const CANONICAL_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "fast"]);
const DISABLED_EFFORTS = new Set(["none", "off", "disabled"]);
const ADAPTIVE_EFFORTS = new Set(["auto", "adaptive"]);
const DEFAULT_MODEL = "swe-2-high";
const MAX_OUTPUT_TOKENS = 64_000;
const NAMESPACE_PREFIX = "devin/";

const STATIC_LEVELS: Readonly<Record<string, readonly string[]>> = {
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-5-fable": ["low", "medium", "high", "xhigh", "max"],
  "gemini-3-8-flash": ["low", "medium", "high"],
  "gemini-3-7-flash": ["low", "medium", "high"],
  "gemini-3-6-flash": ["minimal", "low", "medium", "high"],
  "gemini-3-5-flash": ["minimal", "low", "medium", "high"],
  "gemini-3-1-pro": ["low", "high"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5-6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5-6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5-5": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5-4": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5-4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5-3-codex": ["low", "medium", "high", "xhigh"],
  "glm-5-3": ["low", "high", "max"],
  "glm-5-3-flash": ["low", "high", "max"],
  "kimi-k3": ["low", "high", "max"],
  "grok-4-5": ["low", "medium", "high"],
  "grok-4-6": ["low", "medium", "high", "xhigh"],
  "grok-4-7": ["low", "medium", "high", "xhigh"],
  "inkling": ["none", "low", "medium", "high", "xhigh", "max"],
  "deepseek-v4-flash": ["high", "max"],
  "deepseek-v4-1-flash": ["high", "max"],
  "deepseek-v4-pro": ["high", "max"],
  "nemotron-3-ultra": ["none", "medium", "high"],
  "swe-1-7-lightning": ["medium"],
  "swe-2": ["medium", "high", "max"],
};

const SPECIAL_ALIASES: Readonly<Record<string, string>> = {
  "claude-haiku-4-5": "MODEL_PRIVATE_11",
  "gpt-4-1": "MODEL_CHAT_GPT_4_1_2025_04_14",
};

const UPPER_SUFFIXES: readonly (readonly [string, string])[] = [
  ["_NONE", "none"],
  ["_MINIMAL", "minimal"],
  ["_LOW", "low"],
  ["_MEDIUM", "medium"],
  ["_HIGH", "high"],
  ["_XHIGH", "xhigh"],
  ["_MAX", "max"],
  ["_THINKING", "high"],
];

const COMPOUND_SUFFIXES: readonly { suffix: string; effort: string; tier: DevinVariant["tier"]; readd: string }[] = [
  ...["low", "medium", "high", "xhigh", "max", "none"].flatMap((effort) => [
    { suffix: `-${effort}-fast`, effort, tier: "fast" as const, readd: "" },
    { suffix: `-${effort}-priority`, effort, tier: "priority" as const, readd: "" },
  ]),
  { suffix: "-thinking-1m", effort: "", tier: "", readd: "-1m" },
  { suffix: "-thinking", effort: "", tier: "", readd: "" },
  { suffix: "-max-1m", effort: "max", tier: "", readd: "-1m" },
  { suffix: "-none-1m", effort: "none", tier: "", readd: "-1m" },
];

const SIMPLE_SUFFIXES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const EXPLICIT_SUFFIXES = [
  ...["none", "low", "medium", "high", "xhigh", "max"].flatMap((effort) => [`-${effort}-fast`, `-${effort}-priority`]),
  "-thinking-1m",
  "-max-1m",
  "-none-1m",
  "-none",
  "-low",
  "-medium",
  "-high",
  "-xhigh",
  "-max",
  "-fast",
  "-slow",
  "-priority",
  "-thinking",
  "_none",
  "_minimal",
  "_low",
  "_medium",
  "_high",
  "_xhigh",
  "_max",
  "_thinking",
];

const DISPLAY_SUFFIXES = [
  " Low Fast",
  " Medium Fast",
  " High Fast",
  " XHigh Fast",
  " Max Fast",
  " Low Thinking Fast",
  " Medium Thinking Fast",
  " High Thinking Fast",
  " XHigh Thinking Fast",
  " Max Thinking Fast",
  " No Thinking Fast",
  " Low Thinking",
  " Medium Thinking",
  " High Thinking",
  " XHigh Thinking",
  " Max Thinking",
  " No Thinking",
  " Low",
  " Medium",
  " High",
  " XHigh",
  " Max",
  " None",
  " Minimal",
  " Thinking",
  " Fast",
];

const VENDORS: Readonly<Record<number, string>> = {
  1: "cognition",
  2: "openai",
  3: "anthropic",
  4: "google",
  6: "deepseek",
  7: "moonshot",
  9: "zhipu",
  11: "nvidia",
};

export function devinMaxOutputTokens(requested: number): number {
  return requested > 0 && requested < MAX_OUTPUT_TOKENS ? Math.floor(requested) : MAX_OUTPUT_TOKENS;
}

export function splitDevinUid(uid: string): DevinVariant {
  if (uid === "swe-1-6-slow") return { base: uid, effort: "", tier: "" };
  if (uid === "swe-1-6-fast") return { base: "swe-1-6", effort: "", tier: "fast" };
  const upper = uid.toUpperCase();
  for (const [suffix, effort] of UPPER_SUFFIXES) {
    if (upper.endsWith(suffix) && uid.length > suffix.length) return { base: uid.slice(0, -suffix.length), effort, tier: "" };
  }
  for (const spec of COMPOUND_SUFFIXES) {
    if (uid.endsWith(spec.suffix) && uid.length > spec.suffix.length) {
      return { base: `${uid.slice(0, -spec.suffix.length)}${spec.readd}`, effort: spec.effort, tier: spec.tier };
    }
  }
  for (const effort of SIMPLE_SUFFIXES) {
    const suffix = `-${effort}`;
    if (uid.endsWith(suffix) && uid.length > suffix.length) return { base: uid.slice(0, -suffix.length), effort, tier: "" };
  }
  return { base: uid, effort: "", tier: "" };
}

export function normalizeDevinEffort(level: string, budgetTokens = 0): string {
  const normalized = level.trim().toLowerCase();
  if (CANONICAL_EFFORTS.has(normalized)) return normalized;
  if (DISABLED_EFFORTS.has(normalized)) return "none";
  if (ADAPTIVE_EFFORTS.has(normalized)) return "high";
  if (budgetTokens <= 0) return "";
  if (budgetTokens <= 4096) return "low";
  if (budgetTokens <= 16_384) return "medium";
  if (budgetTokens <= 32_768) return "high";
  return "max";
}

function levelIndex(level: string): number {
  return LEVEL_ORDER.indexOf(level.trim().toLowerCase() as (typeof LEVEL_ORDER)[number]);
}

function clampDevinEffort(requested: string, allowed: readonly string[], fallback: string): string {
  if (!requested) return fallback;
  const wanted = requested.trim().toLowerCase();
  const exact = allowed.find((level) => level.trim().toLowerCase() === wanted);
  if (exact) return exact;
  if (wanted === "none") return fallback;
  const wantedIndex = levelIndex(wanted);
  if (wantedIndex === -1) return fallback;
  let best = fallback;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestIndex = -1;
  for (const level of allowed) {
    const index = levelIndex(level);
    if (index === -1) continue;
    const distance = Math.abs(wantedIndex - index);
    if (distance < bestDistance || (distance === bestDistance && index > bestIndex)) {
      best = level;
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return best;
}

function defaultEffort(base: string, levels: readonly string[]): string {
  if (base.includes("swe-2")) return "high";
  const has = (level: string) => levels.includes(level);
  if (has("none") && has("low") && base.startsWith("gpt-5")) return "low";
  if (has("high") && /gemini|grok|glm|deepseek|kimi|nemotron/.test(base)) return "high";
  if (has("medium")) return "medium";
  if (has("high")) return "high";
  if (has("low")) return "low";
  return levels[0] ?? "";
}

function hasDevinVariantSuffix(model: string): boolean {
  const lower = model.trim().toLowerCase();
  return EXPLICIT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function devinLevels(base: string, variants: readonly string[] | undefined): readonly string[] {
  if (variants?.length) {
    const levels = new Set<string>();
    for (const uid of variants) {
      const variant = splitDevinUid(uid);
      if (variant.base === base && variant.effort && !variant.tier) levels.add(variant.effort);
    }
    if (levels.size) return [...levels].sort((a, b) => (LEVEL_RANK[a] ?? 99) - (LEVEL_RANK[b] ?? 99));
  }
  return STATIC_LEVELS[base] ?? [];
}

function opaqueUid(model: string, effort: string): string {
  const upper = model.toUpperCase();
  if (upper === "MODEL_GPT_5_2") return `${upper}_${clampDevinEffort(effort, ["none", "low", "medium", "high", "xhigh"], "low").toUpperCase()}`;
  if (upper === "MODEL_GOOGLE_GEMINI_3_0_FLASH") {
    return `${upper}_${clampDevinEffort(effort, ["minimal", "low", "medium", "high"], "high").toUpperCase()}`;
  }
  if (upper === "MODEL_CLAUDE_4_5_OPUS") return effort && effort !== "none" ? `${upper}_THINKING` : upper;
  return model;
}

function thinkingUid(base: string, effort: string): string | null {
  const thinking = effort !== "" && effort !== "none";
  switch (base) {
    case "swe-1-7":
      return effort === "medium" ? "swe-1-7-medium" : "swe-1-7";
    case "swe-1-6":
      return effort === "fast" ? "swe-1-6-fast" : "swe-1-6";
    case "glm-5-2":
      return effort === "none" ? "glm-5-2-none" : effort === "max" ? "glm-5-2-max" : "glm-5-2";
    case "glm-5-2-1m":
      return effort === "none" ? "glm-5-2-none-1m" : effort === "max" ? "glm-5-2-max-1m" : "glm-5-2-1m";
    case "claude-opus-4-6":
    case "claude-sonnet-4-6":
      return thinking ? `${base}-thinking` : base;
    case "claude-opus-4-6-1m":
      return thinking ? "claude-opus-4-6-thinking-1m" : base;
    case "claude-sonnet-4-6-1m":
      return thinking ? "claude-sonnet-4-6-thinking-1m" : base;
    default:
      return null;
  }
}

function tiered(uid: string, tier: DevinTierMode, variants: readonly string[] | undefined): string {
  if (!tier || !variants?.length) return uid;
  const candidate = `${uid}-${tier}`;
  return variants.includes(candidate) ? candidate : uid;
}

export function devinModelUid(
  rawModel: string,
  requestedEffort: string,
  variants?: readonly string[],
  tier: DevinTierMode = "",
): string {
  let model = rawModel.trim();
  if (!model) return DEFAULT_MODEL;
  if (model.toLowerCase().startsWith(NAMESPACE_PREFIX)) model = model.slice(NAMESPACE_PREFIX.length);
  if (hasDevinVariantSuffix(model)) return model;
  const effort = normalizeDevinEffort(requestedEffort);
  if (/^MODEL_/i.test(model)) return opaqueUid(model, effort);
  let base = model.toLowerCase().replace(/\./g, "-");
  const special = SPECIAL_ALIASES[base];
  if (special) return special;
  if (base === "claude-sonnet-4-5" || base.includes("sonnet-4-5")) {
    return effort && effort !== "none" ? "MODEL_PRIVATE_3" : "MODEL_PRIVATE_2";
  }
  if (base === "gemini-3-flash") base = "gemini-3-8-flash";
  const fixed = thinkingUid(base, effort);
  if (fixed) return tiered(fixed, tier, variants);
  const levels = devinLevels(base, variants);
  if (!levels.length) return tiered(base, tier, variants);
  return tiered(`${base}-${clampDevinEffort(effort, levels, defaultEffort(base, levels))}`, tier, variants);
}

export function devinTierVariants(variants: readonly string[] | undefined, tier: Exclude<DevinTierMode, "">): boolean {
  return (variants ?? []).some((uid) => splitDevinUid(uid).tier === tier || uid.endsWith(`-${tier}`));
}

export function parseDevinModelConfigs(data: Uint8Array): DevinModelConfig[] {
  const configs: DevinModelConfig[] = [];
  for (const entry of protoFields(data)) {
    if (entry.field !== 1 || entry.wire !== WIRE_BYTES) continue;
    const config: DevinModelConfig = { uid: "", label: "", multimodal: false, vendor: 0, contextLength: 0 };
    for (const field of protoFields(entry.bytes)) {
      if (field.wire === WIRE_BYTES && field.field === 1) config.label = protoText(field);
      if (field.wire === WIRE_BYTES && field.field === 22) config.uid = protoText(field);
      if (field.wire === WIRE_VARINT && field.field === 5) config.multimodal = protoNumber(field) === 1;
      if (field.wire === WIRE_VARINT && field.field === 10) config.vendor = protoNumber(field);
      if (field.wire === WIRE_VARINT && field.field === 18) config.contextLength = protoNumber(field);
    }
    if (config.uid) configs.push(config);
  }
  return configs;
}

export function cleanDevinDisplayName(label: string): string {
  let trimmed = label.trim();
  for (;;) {
    const suffix = DISPLAY_SUFFIXES.find((item) => trimmed.toLowerCase().endsWith(item.toLowerCase()));
    if (!suffix) return trimmed;
    trimmed = trimmed.slice(0, -suffix.length).trim();
  }
}

function vendorName(vendor: number, uid: string): string {
  return VENDORS[vendor] ?? (uid.toLowerCase().includes("grok") ? "xai" : "devin");
}

export function devinModels(configs: DevinModelConfig[]): DiscoveredModel[] {
  const groups = new Map<string, { name: string; vendor: number; context: number; variants: Set<string> }>();
  for (const config of configs) {
    const { base } = splitDevinUid(config.uid);
    const group = groups.get(base) ?? { name: "", vendor: 0, context: 0, variants: new Set<string>() };
    if (config.uid === base || !group.name) group.name = cleanDevinDisplayName(config.label) || group.name;
    if (config.uid === base || !group.vendor) group.vendor = config.vendor || group.vendor;
    group.context = Math.max(group.context, config.contextLength);
    group.variants.add(config.uid);
    groups.set(base, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => ({
      id,
      name: group.name || id,
      ownedBy: vendorName(group.vendor, id),
      contextLength: group.context,
      costInputPer1k: 0,
      costOutputPer1k: 0,
      priceSource: "none",
      variants: [...group.variants].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
