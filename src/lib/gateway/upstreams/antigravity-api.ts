import "server-only";
import { ANTIGRAVITY_BASE_URL, antigravityHeaders } from "@/lib/gateway/upstreams/antigravity";
import { asRecord } from "@/lib/gateway/core";
import { readJsonOr } from "@/lib/utils/json";
import type { UpstreamAuth } from "@/types/gateway";

const MODELS_TIMEOUT_MS = 30_000;

export async function fetchAvailableModels(
  auth: UpstreamAuth,
  baseUrl = "",
): Promise<{ status: number; json: unknown }> {
  const root = (baseUrl.trim() || ANTIGRAVITY_BASE_URL).replace(/\/$/, "");
  try {
    const res = await fetch(`${root}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: {
        ...antigravityHeaders(),
        Authorization: `Bearer ${auth.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ project: auth.project ?? "" }),
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      redirect: "error",
    });
    const json: unknown = res.ok ? asRecord(await readJsonOr(res, null)) : null;
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
}
