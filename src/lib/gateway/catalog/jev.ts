import "server-only";
import { env } from "@/lib/env";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { asNumber, asRecord } from "@/lib/gateway/core";
import { readJsonOr } from "@/lib/utils/json";
import { JEV_NONE } from "@/lib/gateway/catalog/model-catalog";
import type { JevSettings } from "@/types/gateway";
import type { JevTask, JevVerdict } from "@/types/model-catalog";

const JEV_TIMEOUT_MS = 30_000;
const JEV_QUESTION = "same_model";

const OPENROUTER_BASE_URL =
  PROVIDER_CATALOG.find((spec) => spec.kind === "openrouter")?.default_base_url ?? "https://openrouter.ai/api/v1";

export function jevRequest(task: JevTask, model: string) {
  const criteria: Record<string, string> = {};
  for (const candidate of task.candidates) criteria[candidate.alias] = candidate.label;
  criteria[JEV_NONE] = "None of these. It is a different model, size, version, snapshot, or variant.";
  return {
    model,
    state: {
      provider_kind: task.kind,
      provider_model_id: task.upstreamId,
      provider_display_name: task.name || task.upstreamId,
      vendor: task.vendor || "unknown",
    },
    questions: {
      [JEV_QUESTION]: {
        type: "choice",
        instructions:
          "Which public model alias serves exactly the same model as the provider model in the state? Different sizes, versions, snapshots, and variants such as free, thinking, online, or quantized builds are different models.",
        criteria,
      },
    },
  };
}

export function jevVerdict(task: JevTask, json: unknown): JevVerdict | null {
  const answer = asRecord(asRecord(asRecord(json)?.answers)?.[JEV_QUESTION]);
  const choice = typeof answer?.choice === "string" ? answer.choice : "";
  if (!choice || choice === JEV_NONE || !task.candidates.some((candidate) => candidate.alias === choice)) {
    return null;
  }
  const probability = asRecord(answer?.probabilities)?.[choice];
  const raw = typeof probability === "number" ? probability : answer?.confidence;
  const confidence = typeof raw === "number" && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  return { alias: choice, confidence };
}

export function jevReady(settings: JevSettings | undefined): settings is JevSettings {
  return Boolean(settings?.enabled && settings.api_key);
}

function failureCode(status: number): string {
  if (status === 401 || status === 403) return "JEV_AUTH";
  if (status === 402) return "JEV_CREDITS";
  if (status === 429) return "JEV_RATE_LIMITED";
  return "JEV_FAILED";
}

export async function askJev(
  settings: JevSettings,
  task: JevTask,
): Promise<{ verdict: JevVerdict | null; cost: number }> {
  const res = await fetch(`${OPENROUTER_BASE_URL}/systemone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.api_key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "HTTP-Referer": env.NEXT_PUBLIC_APP_URL,
      "X-Title": "LLM Hub",
    },
    body: JSON.stringify(jevRequest(task, settings.model)),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  }).catch(() => {
    throw new Error("JEV_FAILED");
  });
  const json = await readJsonOr(res, null);
  if (!res.ok) throw new Error(failureCode(res.status));
  return {
    verdict: jevVerdict(task, json),
    cost: asNumber(asRecord(asRecord(json)?.usage)?.cost, 0),
  };
}
