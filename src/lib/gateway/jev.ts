import "server-only";
import { env } from "@/lib/env";
import { PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import { asNumber, asRecord } from "@/lib/gateway/core";
import { jevRequest, jevVerdict } from "@/lib/gateway/model-catalog";
import type { JevSettings } from "@/types/gateway";
import type { JevTask, JevVerdict } from "@/types/model-catalog";

const JEV_TIMEOUT_MS = 30_000;

const OPENROUTER_BASE_URL =
  PROVIDER_CATALOG.find((spec) => spec.kind === "openrouter")?.default_base_url ?? "https://openrouter.ai/api/v1";

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
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new Error(failureCode(res.status));
  return {
    verdict: jevVerdict(task, json),
    cost: asNumber(asRecord(asRecord(json)?.usage)?.cost, 0),
  };
}
