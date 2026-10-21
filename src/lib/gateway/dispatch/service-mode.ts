import { claudeVersion } from "@/lib/gateway/protocols/anthropic";
import { asRecord, asString } from "@/lib/gateway/core";
import { DAYBREAK_AUTO, VARIANT_LABELS } from "@/lib/gateway/catalog/model-variants";
import { GateError } from "@/lib/gateway/errors";
import { speaksAnthropic } from "@/lib/gateway/upstreams/provider-kinds";
import { CODEX_FAST_TIER, CODEX_ULTRAFAST_TIER } from "@/lib/gateway/upstreams/codex";
import { devinTierVariants } from "@/lib/gateway/upstreams/devin-models";
import type { HubServiceMode, JsonMap, ModeSupport } from "@/types/gateway";
import type { ModelVariant } from "@/types/models";
import type { ModelFacts, ServiceTarget } from "@/types/routing";

const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";
const ANTHROPIC_FAST_MIN_OPUS = 4.8;
const DAYBREAK_PROGRAMS = ["daybreak_blue", "daybreak_red"] as const;
const PROGRAM_KINDS = new Set(["openai", "codex"]);
const FAST_KINDS = new Set(["openai", "xai", "openrouter", "openrouter_eu"]);
const PREMIUM_MODES = new Set<HubServiceMode>(["fast", "ultrafast", "priority"]);
const STRICT_VARIANTS: readonly ModelVariant[] = ["ultrafast", "daybreak"];

export const CODEX_ROUTING_HINT = "x-codex-routing-hint";

export function anthropicFastSupported(model: string): boolean {
  const version = claudeVersion(model);
  return /claude-opus-/i.test(model) && version !== null && version >= ANTHROPIC_FAST_MIN_OPUS;
}

export function hubServiceMode(
  body: JsonMap | null | undefined,
  groupStrategy = "",
): HubServiceMode {
  const tier = asString(body?.service_tier).trim().toLowerCase();
  const speed = asString(body?.speed).trim().toLowerCase();
  const model = asString(body?.model);
  if (tier === "ultrafast") return "ultrafast";
  if (tier === "priority") return "priority";
  if (tier === "fast" || speed === "fast" || model.endsWith(":nitro")) return "fast";
  if (tier === "flex" || model.endsWith(":floor")) return "flex";
  if (
    tier === "default" ||
    tier === "standard" ||
    tier === "standard_only"
  ) {
    return "default";
  }
  if (groupStrategy === "fast") return "fast";
  if (groupStrategy === "priority") return "priority";
  return "";
}

export function requestRoutingOverride(
  body: JsonMap | null | undefined,
): string {
  const mode = hubServiceMode(body, "");
  if (mode === "priority") return "priority";
  if (mode === "fast" || mode === "ultrafast") return "fast";
  if (mode === "flex") return "cost_lowest";
  return "";
}

function requestedProgram(body: JsonMap | null | undefined): string {
  return asString(asRecord(body?.access_programs)?.cyber).trim().toLowerCase();
}

function listed(values: string[] | undefined, wanted: readonly string[]): ModeSupport {
  return wanted.some((value) => values?.includes(value)) ? "confirmed" : "none";
}

export function modeSupport(
  { kind, model, facts }: ServiceTarget,
  variant: ModelVariant,
  program: string = DAYBREAK_AUTO,
): ModeSupport {
  if (variant === "daybreak") {
    if (kind === "codex") return listed(facts?.accessPrograms, program === DAYBREAK_AUTO ? DAYBREAK_PROGRAMS : [program]);
    return kind === "openai" ? "unverified" : "none";
  }
  if (variant === "ultrafast") {
    if (kind === "codex") return listed(facts?.serviceTiers, [CODEX_ULTRAFAST_TIER]);
    return kind === "openai" ? "unverified" : "none";
  }
  if (kind === "codex") return listed(facts?.serviceTiers, [CODEX_FAST_TIER]);
  if (kind === "devin") return devinTierVariants(facts?.variants, "fast") ? "confirmed" : "none";
  if (speaksAnthropic(kind)) return anthropicFastSupported(model) ? "confirmed" : "none";
  if (FAST_KINDS.has(kind)) return "confirmed";
  return kind === "openai_compat" ? "unverified" : "none";
}

export function requestedVariants(body: JsonMap | null | undefined): ModelVariant[] {
  const variants: ModelVariant[] = [];
  const mode = hubServiceMode(body, "");
  if (mode === "ultrafast") variants.push("ultrafast");
  else if (mode === "fast") variants.push("fast");
  if (requestedProgram(body).startsWith(DAYBREAK_AUTO)) variants.push("daybreak");
  return variants;
}

function unsupportedVariant(variant: ModelVariant): GateError {
  return new GateError(400, "unsupported_parameter", `no route of this model serves ${VARIANT_LABELS[variant]}`, {
    param: variant === "daybreak" ? "access_programs" : "service_tier",
  });
}

export function variantRoutes<T extends ServiceTarget>(
  routes: T[],
  body: JsonMap | null | undefined,
): { serves: (route: T) => boolean; error: GateError | null } {
  const wanted = requestedVariants(body);
  const program = requestedProgram(body);
  const strict = wanted.filter((variant) => STRICT_VARIANTS.includes(variant));
  const supports = (route: T, variant: ModelVariant) => modeSupport(route, variant, program) !== "none";
  const missing = strict.find((variant) => !routes.some((route) => supports(route, variant)));
  if (missing) return { serves: () => false, error: unsupportedVariant(missing) };
  const preferFast = wanted.includes("fast") && routes.some((route) => supports(route, "fast"));
  return {
    serves: (route) => strict.every((variant) => supports(route, variant)) && (!preferFast || supports(route, "fast")),
    error: null,
  };
}

function daybreakProgram(kind: string, facts: ModelFacts | undefined): string {
  if (kind !== "codex") return DAYBREAK_PROGRAMS[0];
  return DAYBREAK_PROGRAMS.find((program) => facts?.accessPrograms?.includes(program)) ?? "";
}

function withAccessPrograms(kind: string, payload: JsonMap, facts: ModelFacts | undefined): void {
  const requested = requestedProgram(payload);
  delete payload.access_programs;
  if (!requested || !PROGRAM_KINDS.has(kind)) return;
  const program = requested === DAYBREAK_AUTO ? daybreakProgram(kind, facts) : requested;
  if (program) payload.access_programs = { cyber: program };
}

function codexTier(mode: HubServiceMode, facts: ModelFacts | undefined): string {
  const offers = (tier: string) => facts?.serviceTiers?.includes(tier) ?? false;
  if (mode === "ultrafast" && offers(CODEX_ULTRAFAST_TIER)) return CODEX_ULTRAFAST_TIER;
  if (PREMIUM_MODES.has(mode) && offers(CODEX_FAST_TIER)) return CODEX_FAST_TIER;
  return "";
}

function mergeProvider(body: JsonMap, patch: JsonMap): JsonMap {
  return {
    ...body,
    provider: {
      ...(asRecord(body.provider) ?? {}),
      ...patch,
    },
  };
}

export function applyProviderServiceMode(
  kind: string,
  body: JsonMap,
  groupStrategy = "",
  upstreamModel = asString(body.model),
  facts?: ModelFacts,
): { body: JsonMap; headers: Record<string, string> } {
  const mode = hubServiceMode(body, groupStrategy);
  let payload: JsonMap = { ...body };
  const headers: Record<string, string> = {};
  withAccessPrograms(kind, payload, facts);

  switch (kind) {
    case "anthropic":
    case "claude": {
      delete payload.service_tier;
      delete payload.speed;
      if ((mode === "fast" || mode === "ultrafast") && anthropicFastSupported(upstreamModel)) {
        payload.speed = "fast";
        headers["anthropic-beta"] = ANTHROPIC_FAST_BETA;
      } else if (mode === "priority") {
        payload.service_tier = "auto";
      } else if (mode === "flex" || mode === "default") {
        payload.service_tier = "standard_only";
      }
      break;
    }
    case "xai": {
      if (PREMIUM_MODES.has(mode)) {
        payload.service_tier = "priority";
      } else if (mode === "default") {
        payload.service_tier = "default";
      } else {
        delete payload.service_tier;
      }
      delete payload.speed;
      break;
    }
    case "openrouter":
    case "openrouter_eu": {
      if (mode === "fast" || mode === "ultrafast") {
        payload.service_tier = "fast";
        payload = mergeProvider(payload, { sort: "latency" });
      } else if (mode === "priority") {
        payload.service_tier = "priority";
        payload = mergeProvider(payload, { sort: "throughput" });
      } else if (mode === "flex") {
        payload.service_tier = "flex";
        payload = mergeProvider(payload, { sort: "price" });
      }
      delete payload.speed;
      break;
    }
    case "codex": {
      const tier = codexTier(mode, facts);
      delete payload.speed;
      delete payload.service_tier;
      if (tier) {
        payload.service_tier = tier;
        headers[CODEX_ROUTING_HINT] = `model=${upstreamModel};tier=${tier}`;
      }
      break;
    }
    case "devin": {
      delete payload.speed;
      delete payload.service_tier;
      if (mode === "fast" || mode === "ultrafast") payload.service_tier = "fast";
      else if (mode === "priority") payload.service_tier = "priority";
      break;
    }
    case "typesafe":
    case "grok_build": {
      delete payload.service_tier;
      delete payload.speed;
      break;
    }
    case "openai": {
      if (mode === "ultrafast") payload.service_tier = "ultrafast";
      else if (mode === "fast" || mode === "priority") payload.service_tier = "priority";
      else if (mode === "flex") payload.service_tier = "flex";
      else if (mode === "default") payload.service_tier = "default";
      delete payload.speed;
      break;
    }
    default: {
      if (mode === "priority" || mode === "flex" || mode === "default") {
        payload.service_tier = mode;
      } else if (mode === "fast" || mode === "ultrafast") {
        payload.service_tier = "priority";
      }
      delete payload.speed;
      break;
    }
  }

  return { body: payload, headers };
}

export function serviceModeHeaders(
  kind: string,
  body: JsonMap,
  groupStrategy = "",
  upstreamModel?: string,
  facts?: ModelFacts,
): Record<string, string> {
  return applyProviderServiceMode(kind, body, groupStrategy, upstreamModel || asString(body.model), facts).headers;
}
