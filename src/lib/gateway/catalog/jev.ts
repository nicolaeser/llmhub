import "server-only";
import { env } from "@/lib/env";
import { digest } from "@/lib/crypto";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { asNumber, asRecord } from "@/lib/gateway/core";
import { readJsonOr } from "@/lib/utils/json";
import { JEV_NONE, JEV_ROUND_SIZE, JEV_SUGGEST_CONFIDENCE } from "@/lib/gateway/catalog/model-catalog";
import type { JevCandidate, JevTask, JevVerdict, JevSettings } from "@/types/model-catalog";

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

export function jevFingerprint(settings: JevSettings | undefined): string {
  if (!settings) return "";
  return digest(`${settings.enabled}|${settings.model}|${settings.api_key}`).slice(0, 16);
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

export function jevRounds(candidates: JevCandidate[]): JevCandidate[][] {
  const rounds: JevCandidate[][] = [];
  for (let start = 0; start < candidates.length; start += JEV_ROUND_SIZE) {
    rounds.push(candidates.slice(start, start + JEV_ROUND_SIZE));
  }
  return rounds;
}

export async function askJevStaged(
  settings: JevSettings,
  task: JevTask,
): Promise<{ verdict: JevVerdict | null; cost: number; calls: number }> {
  if (task.candidates.length <= JEV_ROUND_SIZE) return { ...(await askJev(settings, task)), calls: 1 };
  let cost = 0;
  let calls = 0;
  const finalists: { candidate: JevCandidate; verdict: JevVerdict }[] = [];
  for (const round of jevRounds(task.candidates)) {
    const answer = await askJev(settings, { ...task, candidates: round });
    cost += answer.cost;
    calls += 1;
    const verdict = answer.verdict;
    const candidate = verdict && round.find((item) => item.alias === verdict.alias);
    if (verdict && candidate && verdict.confidence >= JEV_SUGGEST_CONFIDENCE) finalists.push({ candidate, verdict });
  }
  if (finalists.length <= 1) return { verdict: finalists[0]?.verdict ?? null, cost, calls };
  const final = await askJev(settings, { ...task, candidates: finalists.map((row) => row.candidate) });
  return { verdict: final.verdict, cost: cost + final.cost, calls: calls + 1 };
}
