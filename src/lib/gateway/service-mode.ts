import { claudeVersion } from "@/lib/gateway/anthropic";
import { asRecord, asString } from "@/lib/gateway/core";
import type { HubServiceMode, JsonMap } from "@/types/gateway";

const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";
const ANTHROPIC_FAST_MIN_OPUS = 4.8;

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
  if (mode === "fast") return "fast";
  if (mode === "flex") return "cost_lowest";
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
): { body: JsonMap; headers: Record<string, string> } {
  const mode = hubServiceMode(body, groupStrategy);
  let payload: JsonMap = { ...body };
  const headers: Record<string, string> = {};

  switch (kind) {
    case "anthropic": {
      delete payload.service_tier;
      delete payload.speed;
      if (mode === "fast" && anthropicFastSupported(upstreamModel)) {
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
      if (mode === "fast" || mode === "priority") {
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
      if (mode === "fast") {
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
    case "typesafe": {
      delete payload.service_tier;
      delete payload.speed;
      break;
    }
    case "openai": {
      if (mode === "fast" || mode === "priority") payload.service_tier = "priority";
      else if (mode === "flex") payload.service_tier = "flex";
      else if (mode === "default") payload.service_tier = "default";
      delete payload.speed;
      break;
    }
    default: {
      if (mode === "priority" || mode === "flex" || mode === "default") {
        payload.service_tier = mode;
      } else if (mode === "fast") {
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
): Record<string, string> {
  return applyProviderServiceMode(kind, body, groupStrategy, upstreamModel || asString(body.model)).headers;
}
