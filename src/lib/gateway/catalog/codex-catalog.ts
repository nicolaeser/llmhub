import { plainModel } from "@/lib/gateway/catalog/model-alias";
import { CODEX_BASE_INSTRUCTIONS, CODEX_COMPACT_INSTRUCTIONS } from "@/lib/gateway/catalog/codex-instructions";
import { isModelVariant, splitVariant } from "@/lib/gateway/catalog/model-variants";
import { CODEX_FAST_TIER, CODEX_ULTRAFAST_TIER } from "@/lib/gateway/upstreams/codex";
import { modelRole } from "@/lib/models/model-role";
import type { JsonMap } from "@/types/gateway";
import type { CatalogFacts, ModelVariant } from "@/types/models";
import type { RoutePool } from "@/types/routing";

export const CODEX_VERSION_PARAM = "client_version";
export const CODEX_CATALOG_LIMIT = 1_000_000;

const REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
];

const SPEED_TIERS: Partial<Record<ModelVariant, JsonMap>> = {
  fast: { id: CODEX_FAST_TIER, name: "Fast", description: "Faster responses that use your limits at a higher rate" },
  ultrafast: { id: CODEX_ULTRAFAST_TIER, name: "Ultra Fast", description: "Fastest responses at the highest usage rate" },
};

const ROUTE_DESCRIPTION: Record<RoutePool, string> = {
  subscription: "Runs on a signed-in subscription",
  api: "Runs on the API and bills at API prices",
};

function reasons(id: string): boolean {
  return !/non[-_]?reasoning/i.test(id);
}

function codexModel(entry: JsonMap, surface: RoutePool, facts: CatalogFacts, priority: number, instructions: string): JsonMap {
  const id = String(entry.id);
  const route: RoutePool = entry.route === "api" || entry.route === "subscription" ? entry.route : surface;
  const variant = isModelVariant(entry.variant) ? entry.variant : null;
  const plain = plainModel(id);
  const alias = variant ? (splitVariant(plain)?.alias ?? plain) : plain;
  const reasoning = reasons(id);
  const window = facts.windows[route].get(alias);
  const speeds = variant ? [] : (facts.speeds[route].get(alias) ?? []);
  const model: JsonMap = {
    slug: id,
    display_name: typeof entry.display_name === "string" && entry.display_name ? entry.display_name : id,
    description: surface === "subscription" ? ROUTE_DESCRIPTION[route] : null,
    default_reasoning_level: reasoning ? "medium" : null,
    supported_reasoning_levels: reasoning ? REASONING_LEVELS : [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    base_instructions: instructions,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    service_tiers: speeds.flatMap((speed) => SPEED_TIERS[speed] ?? []),
    additional_speed_tiers: speeds.includes("fast") ? ["fast"] : [],
  };
  if (window) {
    model.context_window = window;
    model.max_context_window = window;
  }
  return model;
}

export function codexCatalog(entries: JsonMap[], surface: RoutePool, facts: CatalogFacts): JsonMap {
  const chat = entries.filter((entry) => modelRole([String(entry.id), String(entry.display_name ?? "")]) === "chat");
  const build = (instructions: string) => ({
    models: chat.map((entry, index) => codexModel(entry, surface, facts, index, instructions)),
  });
  const full = build(CODEX_BASE_INSTRUCTIONS);
  return Buffer.byteLength(JSON.stringify(full)) <= CODEX_CATALOG_LIMIT ? full : build(CODEX_COMPACT_INSTRUCTIONS);
}
